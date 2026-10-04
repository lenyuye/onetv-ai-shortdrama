//! SQLite 打开与 migration。migrations/*.sql 按文件名顺序执行一次。

use std::path::Path;

use rusqlite::Connection;

use crate::error::{ProjectError, ProjectResult};

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    ("0002_jobs_result", include_str!("../migrations/0002_jobs_result.sql")),
];

pub fn open(path: &Path) -> ProjectResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> ProjectResult<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> ProjectResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL, applied_at TEXT NOT NULL);",
    )?;
    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_info", [], |r| r.get(0))
        .map_err(ProjectError::from)?;

    for (i, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let v = (i + 1) as i64;
        if v <= current {
            continue;
        }
        tracing::info!("applying migration {name}");
        // DDL 也在事务内执行：若 ALTER 成功后、版本号写入前崩溃，
        // 下次启动整体回滚重放，不会因 "duplicate column" 导致工程库永久打不开
        let txn = conn.unchecked_transaction()?;
        if let Err(e) = txn.execute_batch(sql) {
            // 兼容修复前的残留库：ALTER 已生效但 schema_info 未记录版本。
            // 此时列已存在，重复执行必然报 duplicate column，记录版本号即可自愈
            let msg = e.to_string();
            if msg.contains("duplicate column name") {
                tracing::warn!("migration {name} already partially applied, recording version {v}");
            } else {
                return Err(e.into());
            }
        }
        txn.execute(
            "INSERT INTO schema_info(version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![v, chrono::Utc::now().to_rfc3339()],
        )?;
        txn.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let conn = open_in_memory().unwrap();
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_info", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        // 关键表存在
        for t in [
            "projects", "episodes", "assets", "nodes", "edges", "jobs", "job_events", "outputs",
            "skills", "memories", "audit_logs", "characters", "locations",
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "table {t}");
        }
        migrate(&conn).unwrap();
    }
}
