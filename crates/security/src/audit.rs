//! 审计日志（规格 §9 / §15.2）：JSONL 追加写，只记录必要诊断，不记录密钥。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use parking_lot::Mutex as PMutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditEntry {
    pub time: String,
    pub action: String,
    #[serde(default)]
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egress: Option<serde_json::Value>,
}

pub struct AuditLog {
    path: PathBuf,
    lock: PMutex<()>,
    memory: Mutex<Vec<AuditEntry>>,
}

impl AuditLog {
    pub fn new(dir: &std::path::Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            path: dir.join("audit.jsonl"),
            lock: PMutex::new(()),
            memory: Mutex::new(Vec::new()),
        })
    }

    pub fn record(&self, action: &str, target: &str, egress: Option<serde_json::Value>) {
        // 出站/负载信息入库前强制脱敏（规格 §22.13：日志严禁出现密钥原文）
        let egress = egress.map(|mut v| {
            crate::redact::redact_json_value(&mut v);
            v
        });
        let entry = AuditEntry {
            time: chrono::Utc::now().to_rfc3339(),
            action: action.into(),
            target: target.into(),
            egress,
        };
        if let Ok(mut mem) = self.memory.lock() {
            mem.push(entry.clone());
            if mem.len() > 5000 {
                let drain_to = mem.len() - 2000;
                mem.drain(0..drain_to);
            }
        }
        let _g = self.lock.lock();
        // v2.12.0：超过 10MB 轮转为 .old，防止审计文件无限增长
        if let Ok(meta) = std::fs::metadata(&self.path) {
            if meta.len() > 10 * 1024 * 1024 {
                let old = self.path.with_extension("old.jsonl");
                let _ = std::fs::rename(&self.path, &old);
            }
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            if let Ok(line) = serde_json::to_string(&entry) {
                let _ = writeln!(f, "{line}");
            }
        }
        tracing::info!(action, target, "audit");
    }

    pub fn recent(&self, limit: usize) -> Vec<AuditEntry> {
        self.memory
            .lock()
            .map(|m| m.iter().rev().take(limit).cloned().collect())
            .unwrap_or_default()
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_jsonl_without_keys() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path()).unwrap();
        log.record(
            "egress.sent",
            "provider-1",
            Some(serde_json::json!({"endpoint": "https://api.example.com/v1", "authorization": "Bearer sk-xxx"})),
        );
        let content = std::fs::read_to_string(log.path()).unwrap();
        assert!(content.contains("egress.sent"));
        assert!(!content.contains("sk-xxx"), "密钥不得进入审计日志原文");
    }
}
