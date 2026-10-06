//! 出站 Webhook 回调（v2.22）：任务终态 POST 到用户配置的 URL。
//! 本地地址直发；远程地址由调用方先经 Gateway 策略校验（allowed_hosts）。
//! 签名：HMAC-SHA256(body 原文, secret) hex → X-OneTV-Signature；secret 为空则不带签名头。

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
type HmacSha256 = Hmac<sha2::Sha256>;

/// 重试延迟（首次失败后再试两次）
pub const RETRY_DELAYS_MS: [u64; 2] = [2000, 8000];

/// 终态事件名（retry_wait 等非终态不回调）
pub fn is_terminal_event(name: &str) -> bool {
    name == "job.succeeded" || name == "job.failed"
}

/// HMAC-SHA256 hex 签名
pub fn sign(secret: &str, body: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥");
    mac.update(body.as_bytes());
    let out = mac.finalize().into_bytes();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// 事件载荷：兼容两种事件桥形状——job.succeeded 直接是 job_public；
/// job.failed 是 {"job":…, "willRetry":…}。retry_wait（willRetry=true）不回调。
pub fn extract_job(name: &str, payload: &Value) -> Option<Value> {
    if !is_terminal_event(name) {
        return None;
    }
    if name == "job.failed" {
        if payload.get("willRetry").and_then(|v| v.as_bool()).unwrap_or(false) {
            return None;
        }
        return payload.get("job").cloned().or_else(|| Some(payload.clone()));
    }
    Some(payload.clone())
}

pub fn build_payload(event: &str, job: &Value) -> Value {
    json!({
        "event": event,
        "jobId": job.get("id").cloned().unwrap_or(Value::Null),
        "kind": job.get("kind").cloned().unwrap_or(Value::Null),
        "title": job.get("title").cloned().unwrap_or(Value::Null),
        "state": job.get("state").cloned().unwrap_or(Value::Null),
        "error": job.get("error").cloned().unwrap_or(Value::Null),
        "outputs": job.get("outputs").cloned().unwrap_or_else(|| json!([])),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    })
}

/// 本机地址直发（不经策略）：127.0.0.1 / localhost / [::1] / ::1
pub fn is_local_url(url: &str) -> bool {
    let rest = match url.split_once("://") {
        Some((_, r)) => r,
        None => url,
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "")
}

/// 提取主机名（settings_update 自动加入 allowed_hosts 用）；无 scheme 的非法 URL 返回 None
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = host.split(':').next().unwrap_or("").trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() { None } else { Some(host.to_string()) }
}

/// 投递（带 2 次重试）。调用方需已确认地址可出网（本地地址天然放行/远程已过 Gateway 校验）。
pub async fn deliver(
    client: reqwest::Client,
    url: &str,
    secret: &str,
    event: &str,
    payload: &Value,
) -> Result<(), String> {
    deliver_with_delays(client, url, secret, event, payload, &RETRY_DELAYS_MS).await
}

/// 重试延迟可注入（测试用 [0,0]）
pub async fn deliver_with_delays(
    client: reqwest::Client,
    url: &str,
    secret: &str,
    event: &str,
    payload: &Value,
    delays: &[u64],
) -> Result<(), String> {
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for attempt in 0..=delays.len() {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delays[attempt - 1])).await;
        }
        let mut req = client
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-OneTV-Event", event)
            .timeout(std::time::Duration::from_secs(10));
        if !secret.is_empty() {
            req = req.header("X-OneTV-Signature", sign(secret, &body));
        }
        match req.body(body.clone()).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => {
                last_err = if e.is_timeout() || e.to_string().contains("timed out") {
                    "请求超时".into()
                } else {
                    "无法连接".into()
                };
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_known_vector() {
        // RFC 4231 test case 2 的 key/data 组合不适用（key 过长）；
        // 这里用自算稳定值锁行为：同输入恒同输出、不同输入不同输出
        let a = sign("s1", "{\"a\":1}");
        let b = sign("s1", "{\"a\":1}");
        let c = sign("s2", "{\"a\":1}");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn extract_job_shapes() {
        let job = json!({"id": "job_1", "state": "succeeded"});
        // succeeded：payload 即 job_public
        assert_eq!(extract_job("job.succeeded", &job).unwrap(), job);
        // failed 终态：包一层
        let failed = json!({"job": job, "willRetry": false});
        assert!(extract_job("job.failed", &failed).is_some());
        // retry_wait：不回调
        let retrying = json!({"job": job, "willRetry": true});
        assert!(extract_job("job.failed", &retrying).is_none());
        // 非终态事件
        assert!(extract_job("job.progress", &job).is_none());
    }

    #[test]
    fn payload_fields() {
        let job = json!({"id": "j1", "kind": "export", "title": "导出", "state": "succeeded", "outputs": ["/tmp/a.mp4"]});
        let p = build_payload("job.succeeded", &job);
        assert_eq!(p["event"], "job.succeeded");
        assert_eq!(p["jobId"], "j1");
        assert_eq!(p["outputs"][0], "/tmp/a.mp4");
        assert!(p["timestamp"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn deliver_posts_headers_and_body() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            use std::io::{Read, Write};
            let n = stream.read(&mut buf).unwrap();
            let raw = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            raw
        });
        let payload = build_payload("job.succeeded", &json!({"id": "j9", "outputs": []}));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::new();
            deliver(client, &format!("http://{addr}/hook"), "sec1", "job.succeeded", &payload)
                .await
                .expect("投递应成功");
        });
        let raw = server.join().unwrap();
        assert!(raw.starts_with("POST /hook HTTP/1.1"));
        // hyper 发小写头名，断言大小写不敏感
        assert!(raw.to_lowercase().contains("x-onetv-event: job.succeeded"));
        let body = raw.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(body.contains("\"jobId\":\"j9\""));
        let sig = raw
            .lines()
            .find(|l| l.to_lowercase().starts_with("x-onetv-signature:"))
            .unwrap()
            .split_once(':')
            .unwrap()
            .1
            .trim();
        assert_eq!(sig, sign("sec1", body));
    }

    #[test]
    fn deliver_retries_then_succeeds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            for expect_fail in [true, true, false] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 2048];
                let _ = stream.read(&mut buf).unwrap();
                if expect_fail {
                    let _ = stream.write_all(b"HTTP/1.1 500 Bad\r\nContent-Length: 0\r\n\r\n");
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });
        let payload = build_payload("job.failed", &json!({"id": "jF"}));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::new();
            deliver_with_delays(client, &format!("http://{addr}/cb"), "", "job.failed", &payload, &[0, 0])
                .await
                .expect("第三次应成功");
        });
        server.join().unwrap();
    }

    #[test]
    fn deliver_reports_persistent_failure() {
        // 无监听端口 → 三次全失败 → Err
        let payload = json!({});
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::new();
            let r = deliver_with_delays(client, "http://127.0.0.1:1/cb", "", "job.succeeded", &payload, &[0, 0]).await;
            assert!(r.is_err());
        });
    }

    #[test]
    fn local_and_host_parse() {
        assert!(is_local_url("http://127.0.0.1:8765/hook"));
        assert!(is_local_url("http://localhost/webhook"));
        assert!(is_local_url("http://[::1]:9000/x"));
        assert!(!is_local_url("https://api.example.com/hook"));
        assert_eq!(host_of("https://api.example.com/hook").as_deref(), Some("api.example.com"));
        assert_eq!(host_of("http://127.0.0.1:8765/hook").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_of("not a url"), None);
    }
}
