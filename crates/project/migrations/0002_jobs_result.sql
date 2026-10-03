-- v2.3.4：任务结果元数据（outputs/reply）与尝试次数持久化。
-- 此前 attempts/outputs 不落库，job 列表读回恒为 0/空（任务页 Provider 列与回复展示失真）。
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}';
