//! Model Router（规格 §22.7/§22.8）：业务层只请求能力，Router 决定 Provider+Model。
//!
//! Capability Request → Enabled Providers → 健康状态 → 约束过滤
//! → 用户优先级/成本 → Provider Adapter（含 fallback 策略）。

use super::{Capability, ProviderProfile, ProviderRegistry};

#[derive(Debug, Clone, serde::Serialize)]
pub struct RouteDecision {
    pub provider: ProviderProfile,
    pub model_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fallback_chain: Vec<(String, String)>, // (providerId, modelId)
}

#[derive(Debug, thiserror::Error)]
pub enum RouteError {
    #[error("没有可用 Provider 支持能力 {0}。请在 设置→模型 中添加并启用 Provider")]
    NoProvider(String),
    #[error("能力 {0} 被禁用（Local-only 模式下公网 Provider 被拒绝）")]
    Disabled(String),
}

pub struct ModelRouter;

impl ModelRouter {
    /// 选择执行某能力的 Provider+Model。
    /// preferred: 显式 providerId（节点 Model Override）
    /// allow_fallback: 是否允许跨 Provider 自动切换（默认不跨 Provider 自动提交高成本任务）
    pub fn route(
        registry: &ProviderRegistry,
        capability: Capability,
        preferred_provider: Option<&str>,
        preferred_model: Option<&str>,
        offline_mode: bool,
        allow_fallback: bool,
    ) -> Result<RouteDecision, RouteError> {
        let all = registry.list();
        let mut candidates: Vec<&ProviderProfile> = all
            .iter()
            .filter(|p| p.enabled)
            .filter(|p| !p.models_with(capability).is_empty())
            .collect();

        if offline_mode {
            // Local-only：拒绝公网 Provider（不只是 UI 隐藏，规格 §22.15）
            candidates.retain(|p| is_local_base(&p.base_url));
        }

        // 用户显式指定优先
        if let Some(pid) = preferred_provider {
            if let Some(p) = candidates.iter().find(|p| p.id == pid) {
                let model = preferred_model
                    .map(|m| m.to_string())
                    .or_else(|| p.models_with(capability).first().map(|m| m.model_id.clone()));
                if let Some(m) = model {
                    return Ok(RouteDecision {
                        provider: (*p).clone(),
                        model_id: m,
                        fallback_chain: vec![],
                    });
                }
            }
            return Err(RouteError::NoProvider(format!("{capability:?}(指定 Provider 不可用: {pid})")));
        }

        if candidates.is_empty() {
            return Err(RouteError::NoProvider(capability.as_str().into()));
        }

        // 优先本地 → 再按创建时间稳定排序（空 created_at 视为最新，避免抢占既有默认）
        candidates.sort_by_key(|p| {
            let created = if p.created_at.is_empty() { "9999".to_string() } else { p.created_at.clone() };
            (!is_local_base(&p.base_url), created)
        });

        let primary = candidates[0];
        let model = preferred_model
            .map(|m| m.to_string())
            .unwrap_or_else(|| primary.models_with(capability)[0].model_id.clone());

        let mut fallback_chain = Vec::new();
        if allow_fallback {
            for p in candidates.iter().skip(1).take(2) {
                if let Some(m) = p.models_with(capability).first() {
                    fallback_chain.push((p.id.clone(), m.model_id.clone()));
                }
            }
        }

        Ok(RouteDecision {
            provider: primary.clone(),
            model_id: model,
            fallback_chain,
        })
    }
}

pub fn is_local_base(base_url: &str) -> bool {
    if base_url.starts_with("mock://") {
        return true;
    }
    // 精确解析 host 再比对：前缀匹配会把 http://localhost.evil.com 误判为本机（v2.12.0 修复）
    let Some((_, rest)) = base_url.split_once("://") else {
        return false;
    };
    let host_port = rest.split('/').next().unwrap_or_default();
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || host.starts_with("192.168.")
        || host.starts_with("10.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderDriverKind;

    #[test]
    fn local_base_rejects_lookalike_hosts() {
        assert!(is_local_base("http://localhost:11434"));
        assert!(is_local_base("http://127.0.0.1:8188"));
        assert!(is_local_base("http://[::1]:8766"));
        assert!(is_local_base("http://192.168.1.5/v1"));
        assert!(!is_local_base("http://localhost.evil.com"));
        assert!(!is_local_base("http://127.0.0.1.evil.com"));
        assert!(!is_local_base("https://api.example.com"));
    }


    fn reg_with(ps: Vec<ProviderProfile>) -> ProviderRegistry {
        let dir = tempfile::tempdir().unwrap();
        let mut r = ProviderRegistry::load(dir.path());
        for p in ps {
            r.upsert(p);
        }
        r
    }

    fn prof(id: &str, base: &str, caps: Vec<Capability>, enabled: bool) -> ProviderProfile {
        let mut p = ProviderProfile::new(id, ProviderDriverKind::OpenaiCompatible, base);
        p.id = id.into();
        p.enabled = enabled;
        p.models = vec![super::super::ModelBinding {
            model_id: format!("{id}-m"),
            display_name: id.into(),
            capabilities: caps,
            endpoint: None,
            pricing: None,
            limits: None,
        }];
        p
    }

    #[test]
    fn routes_by_capability_preferring_local() {
        let r = reg_with(vec![
            prof("cloud", "https://api.x.com/v1", vec![Capability::Chat], true),
            prof("local", "http://127.0.0.1:11434", vec![Capability::Chat], true),
        ]);
        let d = ModelRouter::route(&r, Capability::Chat, None, None, false, false).unwrap();
        assert_eq!(d.provider.id, "local", "本地 Provider 优先");
    }

    #[test]
    fn offline_mode_rejects_public() {
        let r = reg_with(vec![prof("cloud", "https://api.x.com/v1", vec![Capability::VideoGeneration], true)]);
        let e = ModelRouter::route(&r, Capability::VideoGeneration, None, None, true, false).unwrap_err();
        assert!(matches!(e, RouteError::NoProvider(_)));
    }

    #[test]
    fn disabled_provider_excluded() {
        let r = reg_with(vec![prof("off", "https://api.x.com/v1", vec![Capability::Chat], false)]);
        assert!(ModelRouter::route(&r, Capability::Chat, None, None, false, false).is_err());
    }

    #[test]
    fn fallback_chain_built_only_when_allowed() {
        let r = reg_with(vec![
            prof("a", "https://a.com/v1", vec![Capability::ImageGeneration], true),
            prof("b", "https://b.com/v1", vec![Capability::ImageGeneration], true),
        ]);
        let d = ModelRouter::route(&r, Capability::ImageGeneration, None, None, false, true).unwrap();
        assert_eq!(d.fallback_chain.len(), 1);
        let d2 = ModelRouter::route(&r, Capability::ImageGeneration, None, None, false, false).unwrap();
        assert!(d2.fallback_chain.is_empty());
    }
}
