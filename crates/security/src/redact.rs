//! 日志/调试信息脱敏（规格 §22.13）：Authorization、X-API-Key、Cookie、token 一律脱敏。

use regex::Regex;
use std::sync::LazyLock;

static RE_AUTH_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)("(?:authorization|x-api-key|x-auth-token|api[-_]?key|cookie|set-cookie|sig|signature|secret|token)"\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)"#).unwrap()
});
static RE_BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*").unwrap());
static RE_QUERY_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:api[-_]?key|key|token|access[-_]?token|sig)=)[^&\s]+").unwrap()
});

pub fn redact_text(input: &str) -> String {
    let s = RE_AUTH_HEADER.replace_all(input, "${1}\"<redacted>\"");
    let s = RE_BEARER.replace_all(&s, "${1}<redacted>");
    let s = RE_QUERY_KEY.replace_all(&s, "${1}<redacted>");
    s.into_owned()
}

/// 对任意 JSON 值做脱敏（保留结构）。
pub fn redact_json_value(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let kl = k.to_lowercase();
                if kl.contains("authorization")
                    || kl.contains("api")
                        && (kl.contains("key") || kl.contains("secret"))
                    || kl == "cookie"
                    || kl.contains("token")
                    || kl == "sig"
                    || kl == "signature"
                    || kl == "secret"
                {
                    if val.is_string() || val.is_null() {
                        *val = serde_json::Value::String("<redacted>".into());
                        continue;
                    }
                }
                redact_json_value(val);
            }
        }
        serde_json::Value::Array(items) => {
            for it in items {
                redact_json_value(it);
            }
        }
        serde_json::Value::String(s) => {
            let r = redact_text(s);
            *s = r;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_headers_and_bearers() {
        let src = r#"{"Authorization":"Bearer sk-abc123def456","x-api-key":"secret-value"}"#;
        let out = redact_text(src);
        assert!(!out.contains("sk-abc123def456"));
        assert!(!out.contains("secret-value"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn redacts_query_tokens() {
        let out = redact_text("https://api.example.com/v1/files?key=AKIA1234567890abcdef");
        assert!(!out.contains("AKIA1234567890abcdef"));
    }

    #[test]
    fn redact_json_recurses() {
        let mut v: serde_json::Value =
            serde_json::from_str(r#"{"a":{"apiKey":"value123456"},"b":"ok"}"#).unwrap();
        redact_json_value(&mut v);
        assert_eq!(v["a"]["apiKey"], "<redacted>");
        assert_eq!(v["b"], "ok");
    }
}
