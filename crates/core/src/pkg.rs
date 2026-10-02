//! 工程包导入导出（规格 §16/§20 TC13）：.ytv → .ytv.zip，另一台机器可恢复。

use std::io::Read;
use std::path::{Path, PathBuf};

use onetv_project::manifest::ProjectManifest;

#[derive(Debug, thiserror::Error)]
pub enum PkgError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Invalid(String),
}

/// 排除项：渲染缓存与日志（工程数据都在 JSON/SQLite/资产里）。
fn excluded(rel: &str) -> bool {
    rel.starts_with("renders/") || rel.starts_with("logs/") || rel.ends_with(".sqlite-wal") || rel.ends_with(".sqlite-shm")
}

pub fn export_project(root: &Path, dest_zip: &Path) -> Result<PathBuf, PkgError> {
    // 导出前 WAL checkpoint，保证 database.sqlite 自包含
    if let Ok(conn) = onetv_project::db::open(&root.join("database.sqlite")) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    let file = std::fs::File::create(dest_zip)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.add_directory(format!("{}/", root.file_name().unwrap_or_default().to_string_lossy()), opts)?;
    let prefix = root.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut total = 0usize;
    for entry in walk(root, root) {
        let rel = entry
            .strip_prefix(root)
            .map_err(|_| PkgError::Invalid("路径错误".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        if excluded(&rel) {
            continue;
        }
        let name = format!("{prefix}/{rel}");
        if entry.is_dir() {
            zip.add_directory(&name, opts)?;
        } else {
            zip.start_file(&name, opts)?;
            std::io::copy(&mut std::fs::File::open(&entry)?, &mut zip)?;
            total += 1;
        }
    }
    zip.finish()?;
    tracing::info!(files = total, dest = %dest_zip.display(), "project exported");
    Ok(dest_zip.to_path_buf())
}

fn walk(root: &Path, dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.push(p.clone());
            out.extend(walk(root, &p));
        } else {
            out.push(p);
        }
    }
    out
}

/// 导入：解包到 parent/<name>.ytv（重名自动 _1），校验 project.json 后返回路径。
pub fn import_project(zip_path: &Path, parent: &Path) -> Result<PathBuf, PkgError> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    // 找到根目录名（唯一顶级目录）
    let mut top: Option<String> = None;
    for i in 0..archive.len() {
        let f = archive.by_index(i)?;
        let name = f.name().to_string();
        let Some(first) = name.split('/').next() else { continue };
        if first.is_empty() {
            continue;
        }
        match &top {
            None => top = Some(first.to_string()),
            Some(t) if *t != first => {
                return Err(PkgError::Invalid("工程包结构异常（多个顶级目录）".into()))
            }
            _ => {}
        }
    }
    let top = top.ok_or_else(|| PkgError::Invalid("空工程包".into()))?;
    if !top.ends_with(".ytv") {
        return Err(PkgError::Invalid("工程包根目录必须是 <名称>.ytv".into()));
    }
    // 防 zip 路径穿越
    for i in 0..archive.len() {
        let name = archive.by_index(i)?.name().to_string();
        if name.contains("..") {
            return Err(PkgError::Invalid("工程包包含可疑路径（..）".into()));
        }
    }

    let mut dest = parent.join(&top);
    let mut i = 1;
    while dest.exists() {
        let stem = top.trim_end_matches(".ytv");
        dest = parent.join(format!("{stem}_{i}.ytv"));
        i += 1;
    }
    std::fs::create_dir_all(&dest)?;

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let rel = f.name().to_string();
        let Some(rel_after_top) = rel.strip_prefix(&format!("{top}/")) else { continue };
        if rel_after_top.is_empty() {
            continue;
        }
        let out_path = dest.join(rel_after_top);
        if f.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut out = std::fs::File::create(&out_path)?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            std::io::Write::write_all(&mut out, &buf)?;
        }
    }

    // 校验 manifest
    ProjectManifest::load(&dest.join("project.json"))
        .map_err(|e| PkgError::Invalid(format!("工程包内 project.json 不合法: {e}")))?;
    tracing::info!(dest = %dest.display(), "project imported");
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use onetv_project::ops;

    #[test]
    fn export_import_roundtrip() {
        let ws = tempfile::tempdir().unwrap();
        let (h, mut m) = ops::create_project(ws.path(), "导出测试", "9:16").unwrap();
        let ep = ops::add_episode(h.root(), &mut m, None).unwrap();
        // 加点内容
        std::fs::write(
            h.root().join(&ep.script),
            r#"{"schemaVersion":"1.0","episodeId":"ep01","title":"T","scenes":[],"updatedAt":""}"#,
        )
        .unwrap();
        let out_zip = ws.path().join("out.zip");
        export_project(h.root(), &out_zip).unwrap();
        assert!(out_zip.exists());

        let dest_parent = tempfile::tempdir().unwrap();
        let restored = import_project(&out_zip, dest_parent.path()).unwrap();
        assert!(restored.join("project.json").exists());
        assert!(restored.join("database.sqlite").exists());
        assert!(restored.join(&ep.script).exists());
        // renders 不导出
        assert!(!restored.join("renders").exists() || restored.join("renders").read_dir().unwrap().count() == 0);

        // 打开的工程可直接使用
        let (h2, m2) = ops::open_project(&restored).unwrap();
        assert_eq!(m2.project.title, "导出测试");
        let eps = ops::list_episodes(h2.root(), &m2).unwrap();
        assert_eq!(eps.len(), 1);
    }

    #[test]
    fn import_rejects_path_traversal() {
        let ws = tempfile::tempdir().unwrap();
        let zip_path = ws.path().join("evil.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("evil.ytv/../../evil.txt", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"x").unwrap();
            zip.finish().unwrap();
        }
        let dest = tempfile::tempdir().unwrap();
        assert!(import_project(&zip_path, dest.path()).is_err());
    }
}
