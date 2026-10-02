//! 冒烟测试辅助：创建真实项目 + 第一集，并写入应用最近列表。
use onetv_project::{manifest::ProjectManifest, ops};

fn main() {
    let ws = std::path::Path::new("/Users/mac/Desktop/OneTV");
    let (handle, mut manifest) =
        ops::create_project(ws, "冒烟测试剧", "9:16").expect("create project");
    let ep = ops::add_episode(handle.root(), &mut manifest, None).expect("add episode");
    println!("created: {}", handle.root().display());
    println!("episode: {} {}", ep.id, ep.title);

    // 写入 settings.json 的 recent_projects
    let settings_path = dirs::data_dir().unwrap().join("OneTV").join("settings.json");
    let mut settings: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".into()))
            .unwrap_or(serde_json::json!({}));
    let now = chrono::Utc::now().to_rfc3339();
    settings["recent_projects"] = serde_json::json!([
        {"path": handle.root().to_string_lossy(), "name": "冒烟测试剧", "last_opened_at": now}
    ]);
    std::fs::write(&settings_path, serde_json::to_string_pretty(&settings).unwrap()).unwrap();
    println!("settings updated");
}
