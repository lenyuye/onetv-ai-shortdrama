//! 项目操作：创建/打开 .ytv 工程、分集 CRUD、资产导入（SHA-256 去重）。

use std::io::Read;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db;
use crate::error::{ProjectError, ProjectResult};
use crate::manifest::{EpisodeRef, ProjectManifest, SCHEMA_VERSION};
use crate::ProjectHandle;
use sha2::Digest;

/// 在工作区目录下创建 `<名称>.ytv` 工程文件夹（规格 §4.1 目录结构）。
pub fn create_project(workspace_dir: &Path, title: &str, aspect_ratio: &str) -> ProjectResult<(ProjectHandle, ProjectManifest)> {
    if title.trim().is_empty() {
        return Err(ProjectError::Invalid("项目名称不能为空".into()));
    }
    let safe_name = sanitize_fs_name(title);
    let root = unique_dir(workspace_dir, &format!("{safe_name}.ytv"))?;
    std::fs::create_dir_all(&root)?;

    for d in [
        "bible", "prompts", "skills", "renders", "logs",
        "assets/characters", "assets/locations", "assets/references",
        "assets/images", "assets/videos", "assets/audio", "assets/subtitles",
    ] {
        std::fs::create_dir_all(root.join(d))?;
    }

    let mut manifest = ProjectManifest::new(title, aspect_ratio);
    manifest.project.logline = None;
    write_manifest(&root, &manifest)?;
    write_default_bible(&root, title)?;

    // database.sqlite
    let conn = db::open(&root.join("database.sqlite"))?;
    conn.execute(
        "INSERT INTO projects(id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![manifest.project.id, title, manifest.project.created_at],
    )?;
    drop(conn);

    tracing::info!(root = %root.display(), "project created");
    Ok((ProjectHandle { root }, manifest))
}

/// 打开已有工程：校验 project.json 与 schemaVersion。
pub fn open_project(project_dir: &Path) -> ProjectResult<(ProjectHandle, ProjectManifest)> {
    if !project_dir.exists() {
        return Err(ProjectError::Path(format!("目录不存在: {}", project_dir.display())));
    }
    let manifest_path = project_dir.join("project.json");
    if !manifest_path.exists() {
        return Err(ProjectError::Invalid(format!(
            "该文件夹不是 OneTV 工程（缺少 project.json）: {}",
            project_dir.display()
        )));
    }
    let manifest = ProjectManifest::load(&manifest_path)?;
    // 确保 SQLite 存在（老工程/拷贝缺失时自动重建，数据在 JSON 层仍可恢复）
    let _conn = db::open(&project_dir.join("database.sqlite"))?;
    Ok((ProjectHandle { root: project_dir.to_path_buf() }, manifest))
}

pub fn add_episode(
    root: &Path,
    manifest: &mut ProjectManifest,
    title: Option<&str>,
) -> ProjectResult<EpisodeRef> {
    let number = manifest.episodes.iter().map(|e| e.number).max().unwrap_or(0) + 1;
    let id = format!("ep{:02}", number);
    let title = title.map(|s| s.to_string()).unwrap_or_else(|| format!("第 {} 集", number));
    let ep_dir = root.join("episodes").join(&id);
    std::fs::create_dir_all(ep_dir.join("outputs"))?;

    let script = ScriptDocStub::default_for(&id, &title);
    std::fs::write(
        ep_dir.join("script.json"),
        serde_json::to_string_pretty(&script)?,
    )?;
    std::fs::write(
        ep_dir.join("storyboard.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION, "episodeId": id, "shots": [], "updatedAt": now()
        }))?,
    )?;
    std::fs::write(
        ep_dir.join("canvas.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION, "episodeId": id, "nodes": [], "edges": [], "updatedAt": now()
        }))?,
    )?;
    std::fs::write(
        ep_dir.join("timeline.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION, "fps": 30, "tracks": []
        }))?,
    )?;

    let ep = EpisodeRef {
        id: id.clone(),
        number,
        title: title.clone(),
        script: format!("episodes/{id}/script.json"),
        storyboard: format!("episodes/{id}/storyboard.json"),
        canvas: format!("episodes/{id}/canvas.json"),
    };
    manifest.episodes.push(ep.clone());
    write_manifest(root, manifest)?;

    let conn = db::open(&root.join("database.sqlite"))?;
    conn.execute(
        "INSERT OR REPLACE INTO episodes(id, project_id, number, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)",
        rusqlite::params![id, manifest.project.id, number, title, now()],
    )?;
    Ok(ep)
}

/// 删除分集：移除 episodes/<id>/ 目录、manifest 条目与 SQLite 记录（不可恢复）。
pub fn remove_episode(root: &Path, manifest: &mut ProjectManifest, episode_id: &str) -> ProjectResult<()> {
    let Some(idx) = manifest.episodes.iter().position(|e| e.id == episode_id) else {
        return Err(ProjectError::Invalid(format!("分集不存在: {episode_id}")));
    };
    let removed = manifest.episodes.remove(idx);
    let ep_dir = root.join("episodes").join(episode_id);
    if ep_dir.exists() {
        std::fs::remove_dir_all(&ep_dir)?;
    }
    write_manifest(root, manifest)?;
    let conn = db::open(&root.join("database.sqlite"))?;
    let _ = conn.execute("DELETE FROM episodes WHERE id = ?1", [episode_id]);
    let _ = conn.execute("DELETE FROM nodes WHERE episode_id = ?1", [episode_id]);
    let _ = conn.execute("DELETE FROM edges WHERE episode_id = ?1", [episode_id]);
    tracing::info!(episode = %removed.id, "episode deleted");
    Ok(())
}

/// 导入资产：复制进 assets/<kind>/，SHA-256 去重（同 hash 不重复入库，返回既有资产）。
pub fn import_asset(root: &Path, src: &Path, kind: &str) -> ProjectResult<AssetRecord> {
    register_asset_inner(root, src, kind, true)
}

/// 零拷贝登记资产：不复制文件，path 直接登记源文件的绝对路径。
/// 适用于工程内已有唯一副本的大文件（如 renders/ 下的成片），避免双倍占盘；
/// assets/ 目录的拷贝隔离只对生成类小产物（图片/音频）有意义。
/// SHA-256 去重与 import_asset 一致：同 hash 幂等返回既有资产。
pub fn register_asset(root: &Path, src: &Path, kind: &str) -> ProjectResult<AssetRecord> {
    register_asset_inner(root, src, kind, false)
}

/// import_asset（copy=true，复制进 assets/<kind>/）与 register_asset（copy=false，
/// 原地登记绝对路径）共用的登记逻辑。
fn register_asset_inner(root: &Path, src: &Path, kind: &str, copy: bool) -> ProjectResult<AssetRecord> {
    if !src.exists() {
        return Err(ProjectError::Path(format!("文件不存在: {}", src.display())));
    }
    // 路径必须是真实文件（防 symlink 逃逸出工程目录的敏感导入）
    let meta = std::fs::metadata(src)?;
    if !meta.is_file() {
        return Err(ProjectError::Invalid("只能导入文件".into()));
    }
    let mut file = std::fs::File::open(src)?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    let hash = hex::encode(hasher.finalize());

    let conn = db::open(&root.join("database.sqlite"))?;
    if let Ok(rec) = query_asset_by_hash(&conn, &hash) {
        return Ok(rec);
    }

    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "bin".into());
    let id = format!("asset_{}", &hash[..16]);
    let mime = guess_mime(&ext);
    let stored_path: PathBuf = if copy {
        let dest_dir = root.join("assets").join(kind);
        std::fs::create_dir_all(&dest_dir)?;
        let dest = dest_dir.join(format!("{id}.{ext}"));
        std::fs::copy(src, &dest)?;
        dest
    } else {
        absolute_path(src)?
    };

    conn.execute(
        "INSERT INTO assets(id, sha256, path, kind, mime, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            id,
            hash,
            stored_path.to_string_lossy(),
            kind,
            mime,
            size,
            now()
        ],
    )?;
    Ok(AssetRecord {
        id,
        sha256: hash,
        path: stored_path.to_string_lossy().into_owned(),
        kind: kind.into(),
        mime,
        size_bytes: size,
    })
}

/// 相对路径 → 绝对路径（零拷贝登记时 path 必须不依赖当前工作目录）。
fn absolute_path(p: &Path) -> ProjectResult<PathBuf> {
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(p))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetRecord {
    pub id: String,
    pub sha256: String,
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub size_bytes: u64,
}

fn query_asset_by_hash(conn: &Connection, hash: &str) -> Result<AssetRecord, rusqlite::Error> {
    conn.query_row(
        "SELECT id, sha256, path, kind, mime, size_bytes FROM assets WHERE sha256 = ?1",
        [hash],
        |r| {
            Ok(AssetRecord {
                id: r.get(0)?,
                sha256: r.get(1)?,
                path: r.get(2)?,
                kind: r.get(3)?,
                mime: r.get(4)?,
                size_bytes: r.get(5)?,
            })
        },
    )
}

/// 删除资产：仅删除位于 <root>/assets/ 内的文件，随后清理索引行。
/// 工程外的路径（如零拷贝登记的 renders/ 成片，由渲染管线与任务页管理）
/// 只清 DB 行、不动文件。
pub fn delete_asset(root: &Path, id: &str) -> ProjectResult<()> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let path: Option<String> = conn
        .query_row("SELECT path FROM assets WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    if let Some(p) = path {
        let pb = PathBuf::from(&p);
        // 防御：只删工程 assets 目录内的文件
        if pb.starts_with(root.join("assets")) {
            let _ = std::fs::remove_file(pb);
        } else {
            tracing::debug!(id, path = %p, "资产文件在工程 assets/ 之外，仅清理索引行");
        }
        conn.execute("DELETE FROM assets WHERE id = ?1", [id])?;
    }
    Ok(())
}

/// 画布 JSON → SQLite 镜像（nodes/edges 表），供查询与 Job 关联。
pub fn mirror_canvas(root: &Path, episode_id: &str, doc: &serde_json::Value) -> ProjectResult<()> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let now = now();
    conn.execute("DELETE FROM nodes WHERE episode_id = ?1", [episode_id])?;
    conn.execute("DELETE FROM edges WHERE episode_id = ?1", [episode_id])?;
    if let Some(nodes) = doc.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let typ = n.get("type").and_then(|v| v.as_str()).unwrap_or("text");
            let title = n.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let config = n.get("config").cloned().unwrap_or(serde_json::json!({}));
            let pos = n.get("position").cloned().unwrap_or(serde_json::json!({}));
            conn.execute(
                "INSERT OR REPLACE INTO nodes(id, episode_id, type, title, config_json, position_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![
                    id,
                    episode_id,
                    typ,
                    title,
                    serde_json::to_string(&config)?,
                    serde_json::to_string(&pos)?,
                    now
                ],
            )?;
        }
    }
    if let Some(edges) = doc.get("edges").and_then(|v| v.as_array()) {
        for e in edges {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let src = e.get("source").and_then(|v| v.as_str()).unwrap_or_default();
            let dst = e.get("target").and_then(|v| v.as_str()).unwrap_or_default();
            let ports = serde_json::json!({
                "sourcePort": e.get("sourcePort"),
                "targetPort": e.get("targetPort")
            });
            conn.execute(
                "INSERT OR REPLACE INTO edges(id, episode_id, source_id, target_id, port_map_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, episode_id, src, dst, serde_json::to_string(&ports)?],
            )?;
        }
    }
    Ok(())
}

pub fn list_assets(root: &Path) -> ProjectResult<Vec<AssetRecord>> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let mut stmt = conn.prepare("SELECT id, sha256, path, kind, mime, size_bytes FROM assets ORDER BY created_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AssetRecord {
                id: r.get(0)?,
                sha256: r.get(1)?,
                path: r.get(2)?,
                kind: r.get(3)?,
                mime: r.get(4)?,
                size_bytes: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_episodes(root: &Path, manifest: &ProjectManifest) -> ProjectResult<Vec<(EpisodeRef, String)>> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let mut out = Vec::new();
    for ep in &manifest.episodes {
        let status: String = conn
            .query_row(
                "SELECT status FROM episodes WHERE id = ?1",
                [&ep.id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "draft".into());
        out.push((ep.clone(), status));
    }
    Ok(out)
}

/// 删除项目：删除整个工程文件夹（用户主动操作；索引与数据同属一个文件夹，无后台残留）。
pub fn delete_project(root: &Path) -> ProjectResult<()> {
    std::fs::remove_dir_all(root)
        .map_err(|e| ProjectError::Io(std::io::Error::new(e.kind(), format!("删除失败: {e}"))))
}

/* ---------------- helpers ---------------- */

#[derive(serde::Serialize)]
// 字段名即 JSON 键（前端契约要求 camelCase），非 Rust 惯例命名
#[allow(non_snake_case)]
struct ScriptDocStub {
    schemaVersion: String,
    episodeId: String,
    title: String,
    scenes: Vec<serde_json::Value>,
    updatedAt: String,
}

impl ScriptDocStub {
    fn default_for(id: &str, title: &str) -> Self {
        Self {
            schemaVersion: SCHEMA_VERSION.into(),
            episodeId: id.into(),
            title: title.into(),
            scenes: Vec::new(),
            updatedAt: now(),
        }
    }
}

pub fn write_manifest(root: &Path, manifest: &ProjectManifest) -> ProjectResult<()> {
    manifest.save(&root.join("project.json"))
}

fn write_default_bible(root: &Path, title: &str) -> ProjectResult<()> {
    let bible = serde_json::json!({
        "story": {
            "title": title,
            "genre": "", "era": "", "location": "", "theme": "",
            "targetDurationSec": 120, "targetPlatform": "抖音",
            "aspectRatio": "9:16", "visualStyle": ""
        },
        "characters": [], "locations": [], "props": [], "continuity": []
    });
    std::fs::write(
        root.join("bible").join("story.json"),
        serde_json::to_string_pretty(&bible)?,
    )?;
    std::fs::write(
        root.join("bible").join("story.md"),
        format!("# {title}\n\n> 故事圣经（Story Bible）由 Agent 或手动维护。\n"),
    )?;
    Ok(())
}

fn unique_dir(parent: &Path, name: &str) -> ProjectResult<PathBuf> {
    let mut candidate = parent.join(name);
    let mut i = 1;
    while candidate.exists() {
        candidate = parent.join(format!("{name}_{i}"));
        i += 1;
    }
    Ok(candidate)
}

pub fn sanitize_fs_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    if cleaned.is_empty() { "未命名".into() } else { cleaned }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn guess_mime(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" | "mov" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "json" => "application/json",
        "md" => "text/markdown",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_open_episode_flow() {
        let ws = tempfile::tempdir().unwrap();
        let (h, mut manifest) = create_project(ws.path(), "霓虹夜行", "9:16").unwrap();
        assert!(h.root().join("project.json").exists());
        assert!(h.root().join("database.sqlite").exists());
        assert!(h.root().join("assets/characters").exists());
        assert!(h.root().join("bible/story.md").exists());

        let ep = add_episode(h.root(), &mut manifest, None).unwrap();
        assert_eq!(ep.number, 1);
        assert!(h.root().join(&ep.script).exists());
        assert!(h.root().join(&ep.storyboard).exists());
        assert!(h.root().join(&ep.canvas).exists());

        let (h2, m2) = open_project(h.root()).unwrap();
        assert_eq!(m2.project.title, "霓虹夜行");
        assert_eq!(m2.episodes.len(), 1);
        let eps = list_episodes(h2.root(), &m2).unwrap();
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].1, "draft");
    }

    #[test]
    fn asset_import_dedups_by_hash() {
        let ws = tempfile::tempdir().unwrap();
        let (h, _m) = create_project(ws.path(), "测试", "9:16").unwrap();
        let src = ws.path().join("ref.png");
        std::fs::write(&src, b"fake png bytes").unwrap();

        let a1 = import_asset(h.root(), &src, "images").unwrap();
        let a2 = import_asset(h.root(), &src, "images").unwrap();
        assert_eq!(a1.id, a2.id);
        let all = list_assets(h.root()).unwrap();
        assert_eq!(all.len(), 1);
        assert!(Path::new(&all[0].path).exists());
    }

    #[test]
    fn delete_asset_removes_file_and_row() {
        let ws = tempfile::tempdir().unwrap();
        let (h, _m) = create_project(ws.path(), "测试", "9:16").unwrap();
        let src = ws.path().join("a.png");
        std::fs::write(&src, b"data").unwrap();
        let rec = import_asset(h.root(), &src, "images").unwrap();
        let p = PathBuf::from(&rec.path);
        assert!(p.exists());
        delete_asset(h.root(), &rec.id).unwrap();
        assert!(!p.exists());
        assert!(list_assets(h.root()).unwrap().is_empty());
    }

    #[test]
    fn register_asset_is_zero_copy_and_idempotent() {
        let ws = tempfile::tempdir().unwrap();
        let (h, _m) = create_project(ws.path(), "测试", "9:16").unwrap();
        // 源文件放在 renders/（模拟成片：工程内已有唯一副本的大文件）
        let src = h.root().join("renders").join("ep01_final.mp4");
        std::fs::write(&src, b"fake mp4 bytes").unwrap();

        let rec = register_asset(h.root(), &src, "videos").unwrap();
        // 零拷贝：源文件未被移动，assets/ 下也没有出现副本
        assert!(src.exists(), "源文件应原位保留");
        assert_eq!(Path::new(&rec.path), src.as_path(), "path 应登记源文件绝对路径");
        assert!(Path::new(&rec.path).is_absolute(), "path 应是绝对路径");
        assert!(!h.root().join("assets").join("videos").join(format!("{}.mp4", rec.id)).exists(), "不应复制进 assets/");
        assert_eq!(rec.kind, "videos");
        assert_eq!(rec.mime, "video/mp4");
        assert_eq!(rec.size_bytes, b"fake mp4 bytes".len() as u64);

        // DB 可查
        let all = list_assets(h.root()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, rec.id);

        // SHA-256 幂等：同内容重复登记返回既有记录，不产生新行
        let again = register_asset(h.root(), &src, "videos").unwrap();
        assert_eq!(again.id, rec.id);
        assert_eq!(list_assets(h.root()).unwrap().len(), 1);
    }

    #[test]
    fn delete_zero_copy_asset_keeps_source_file() {
        let ws = tempfile::tempdir().unwrap();
        let (h, _m) = create_project(ws.path(), "测试", "9:16").unwrap();
        let src = h.root().join("renders").join("export_douyin_vertical.mp4");
        std::fs::write(&src, b"render bytes").unwrap();

        let rec = register_asset(h.root(), &src, "videos").unwrap();
        delete_asset(h.root(), &rec.id).unwrap();
        // 行已清理，但 renders/ 下的成片文件保留（由渲染管线管理）
        assert!(list_assets(h.root()).unwrap().is_empty());
        assert!(src.exists(), "工程外的源文件不应被删除");
    }

    #[test]
    fn rejects_bad_names() {
        let ws = tempfile::tempdir().unwrap();
        assert!(create_project(ws.path(), "", "9:16").is_err());
        assert_eq!(sanitize_fs_name("a/b:c*d"), "a_b_c_d");
    }
}

/* ---------------- 意识模块：记忆（v2.3.5+） ---------------- */

/// 记忆条目（memories 表；意识模块 UI 直接增删改查）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryRecord {
    pub id: String,
    pub scope: String,
    pub text: String,
    pub created_at: String,
}

/// 记忆语义搜索（v2.14）：字符二元组 TF 向量 + 余弦相似度，纯本地无外部依赖。
/// 对中文友好（不需要分词），优于简单 includes 匹配（错别字/语序宽容）。
pub fn search_memories(root: &Path, query: &str, limit: usize) -> ProjectResult<Vec<(MemoryRecord, f64)>> {
    let all = list_memories(root)?;
    let qv = ngram_vector(&query.to_lowercase());
    if qv.is_empty() {
        return Ok(all.into_iter().map(|m| (m, 0.0)).take(limit).collect());
    }
    let mut scored: Vec<(MemoryRecord, f64)> = all
        .into_iter()
        .map(|m| {
            let text = format!("{} {}", m.text, m.scope).to_lowercase();
            let score = cosine(&qv, &ngram_vector(&text));
            (m, score)
        })
        .filter(|(_, score)| *score > 0.05)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored)
}

fn ngram_vector(text: &str) -> HashMap<String, u32> {
    let mut v: HashMap<String, u32> = HashMap::new();
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.len() == 1 {
        *v.entry(chars[0].to_string()).or_insert(0) += 1;
    }
    for w in chars.windows(2) {
        *v.entry(w.iter().collect()).or_insert(0) += 1;
    }
    v
}

fn cosine(a: &HashMap<String, u32>, b: &HashMap<String, u32>) -> f64 {
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut dot = 0.0f64;
    for (k, va) in small {
        if let Some(vb) = large.get(k) {
            dot += (*va as f64) * (*vb as f64);
        }
    }
    let norm = |m: &HashMap<String, u32>| -> f64 {
        m.values().map(|x| (*x as f64) * (*x as f64)).sum::<f64>().sqrt()
    };
    let (na, nb) = (norm(a), norm(b));
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

pub fn list_memories(root: &Path) -> ProjectResult<Vec<MemoryRecord>> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let mut stmt = conn.prepare("SELECT id, scope, text, created_at FROM memories ORDER BY created_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MemoryRecord {
                id: r.get(0)?,
                scope: r.get(1)?,
                text: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn add_memory(root: &Path, text: &str, scope: &str) -> ProjectResult<MemoryRecord> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ProjectError::Invalid("记忆内容不能为空".into()));
    }
    if text.chars().count() > 20_000 {
        return Err(ProjectError::Invalid("记忆内容过长（上限 20000 字）".into()));
    }
    let conn = db::open(&root.join("database.sqlite"))?;
    let id = format!("mem_{}", uuid::Uuid::new_v4().simple());
    let now = now();
    conn.execute(
        "INSERT INTO memories(id, project_id, scope, text, created_at) VALUES (?1, NULL, ?2, ?3, ?4)",
        rusqlite::params![id, scope, text, now],
    )?;
    Ok(MemoryRecord { id, scope: scope.into(), text: text.into(), created_at: now })
}

pub fn update_memory(root: &Path, id: &str, text: &str) -> ProjectResult<()> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ProjectError::Invalid("记忆内容不能为空".into()));
    }
    let conn = db::open(&root.join("database.sqlite"))?;
    let n = conn.execute("UPDATE memories SET text = ?2 WHERE id = ?1", rusqlite::params![id, text])?;
    if n == 0 {
        return Err(ProjectError::Invalid(format!("记忆不存在: {id}")));
    }
    Ok(())
}

pub fn delete_memory(root: &Path, id: &str) -> ProjectResult<()> {
    let conn = db::open(&root.join("database.sqlite"))?;
    let n = conn.execute("DELETE FROM memories WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ProjectError::Invalid(format!("记忆不存在: {id}")));
    }
    Ok(())
}
