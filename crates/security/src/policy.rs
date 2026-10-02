//! 网络出站策略（规格 §9.2 / §22.7）。
//!
//! 默认规则：
//!   ALLOW  localhost / 私网（本机 Ollama、ComfyUI、LAN 自建服务）
//!   ALLOW  用户明确配置的 Provider Base URL
//!   DENY   其他域名
//!   DENY   telemetry / analytics / crash upload（本产品根本不存在这些调用，双保险）
//!
//! Offline Mode（Local-only）：公网一律拒绝，仅放行本机回环与私网。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NetworkPolicy {
    /// Local-only：拒绝一切公网出站
    #[serde(default)]
    pub offline_mode: bool,
    /// 用户明确配置的允许主机（来自 Provider Base URL，域名或 host:port）
    #[serde(default)]
    pub allowed_hosts: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum PolicyDecision {
    Allowed { reason: String },
    Denied { reason: String },
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]" | "0.0.0.0")
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr::{V4, V6};
    match ip {
        V4(v4) => v4.is_private() || v4.is_link_local(),
        V6(v6) => {
            // 唯一本地地址 fc00::/7 与链路本地 fe80::/10 视为私网
            let seg = v6.segments();
            (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
        }
    }
}

fn is_private_lan(host: &str) -> bool {
    // 10.x / 172.16-31.x / 192.168.x / *.local / mDNS
    if let Some(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
    {
        return is_private_ip(ip);
    }
    if host.ends_with(".local") || host.ends_with(".lan") {
        return true;
    }
    false
}

/// mock:// 驱动不出网
pub fn is_mock_scheme(url: &str) -> bool {
    url.starts_with("mock://")
}

impl NetworkPolicy {
    pub fn new(offline_mode: bool) -> Self {
        Self { offline_mode, allowed_hosts: HashSet::new() }
    }

    /// 从 Provider Base URL 注册允许主机（仅 host，不含 scheme/path）。
    pub fn allow_base_url(&mut self, base_url: &str) {
        if let Some(host) = host_of(base_url) {
            self.allowed_hosts.insert(host);
        }
    }

    pub fn revoke_base_url(&mut self, base_url: &str) {
        if let Some(host) = host_of(base_url) {
            self.allowed_hosts.remove(&host);
        }
    }

    pub fn check_url(&self, url: &str) -> PolicyDecision {
        if is_mock_scheme(url) {
            return PolicyDecision::Allowed { reason: "mock provider（不出网）".into() };
        }
        let Some(host) = host_of(url) else {
            return PolicyDecision::Denied { reason: format!("无法解析 URL 主机: {url}") };
        };

        if is_loopback(&host) {
            return PolicyDecision::Allowed { reason: "本机回环服务".into() };
        }
        if self.offline_mode {
            if is_private_lan(&host) {
                return PolicyDecision::Allowed { reason: "Local-only 模式放行私网".into() };
            }
            return PolicyDecision::Denied {
                reason: format!("Local-only 离线模式已开启，拒绝公网请求: {host}"),
            };
        }
        if is_private_lan(&host) {
            return PolicyDecision::Allowed { reason: "私网服务".into() };
        }
        if self.allowed_hosts.contains(&host) {
            return PolicyDecision::Allowed { reason: "用户配置的 Provider 域名".into() };
        }
        PolicyDecision::Denied {
            reason: format!("主机 {host} 不在允许列表中。网络请求只能发往用户配置的 Provider"),
        }
    }
}

pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_denies_unknown_public_hosts() {
        let p = NetworkPolicy::new(false);
        assert!(matches!(
            p.check_url("https://evil.example.com/upload"),
            PolicyDecision::Denied { .. }
        ));
        assert!(matches!(
            p.check_url("http://127.0.0.1:11434/api/tags"),
            PolicyDecision::Allowed { .. }
        ));
    }

    #[test]
    fn allowlisted_provider_passes() {
        let mut p = NetworkPolicy::new(false);
        p.allow_base_url("https://api.example.com/v1");
        assert!(matches!(
            p.check_url("https://api.example.com/v1/chat/completions"),
            PolicyDecision::Allowed { .. }
        ));
        assert!(matches!(
            p.check_url("https://other.example.com/v1/chat/completions"),
            PolicyDecision::Denied { .. }
        ));
    }

    #[test]
    fn offline_blocks_public_allows_local() {
        let mut p = NetworkPolicy::new(true);
        p.allow_base_url("https://api.example.com/v1");
        assert!(matches!(
            p.check_url("https://api.example.com/v1/chat/completions"),
            PolicyDecision::Denied { .. }
        ));
        assert!(matches!(
            p.check_url("http://127.0.0.1:8188/prompt"),
            PolicyDecision::Allowed { .. }
        ));
        assert!(matches!(
            p.check_url("http://192.168.1.10:8000/generate"),
            PolicyDecision::Allowed { .. }
        ));
    }

    #[test]
    fn mock_never_network() {
        let p = NetworkPolicy::new(true);
        assert!(matches!(
            p.check_url("mock://local/image"),
            PolicyDecision::Allowed { .. }
        ));
    }
}
