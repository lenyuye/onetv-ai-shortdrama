//! 黄金管线验收测试（规格 §19 第一个里程碑 / §20 TC02-TC10 的核心链路）：
//! 创建项目 → Mock LLM 生成剧本 → 拆分镜头 → 批量分镜图 → 本地 FFmpeg 合成成片。
//! 全程离线（Mock Provider + 本机 FFmpeg），验证 Local-first 可用性。

use std::sync::Arc;
use std::time::{Duration, Instant};

use onetv_core::agent::executor::{register_all_handlers, Executor};
use onetv_core::agent::AgentEnv;
use onetv_core::jobs::{JobManager, JobState};
use onetv_core::providers::gateway::Gateway;
use onetv_core::providers::{Capability, ModelBinding, ProviderDriverKind, ProviderProfile, ProviderRegistry};
use onetv_project::ops;
use parking_lot::RwLock;

fn mock_provider() -> ProviderProfile {
    let mut p = ProviderProfile::new("mock", ProviderDriverKind::Mock, "mock://local");
    p.id = "builtin-mock".into();
    p.models = vec![
        ModelBinding {
            model_id: "mock-chat-v1".into(),
            display_name: "mock-chat-v1".into(),
            capabilities: vec![Capability::Chat, Capability::StructuredOutput],
            endpoint: None,
            pricing: None,
            limits: None,
        },
        ModelBinding {
            model_id: "mock-image-v1".into(),
            display_name: "mock-image-v1".into(),
            capabilities: vec![Capability::ImageGeneration],
            endpoint: None,
            pricing: None,
            limits: None,
        },
        ModelBinding {
            model_id: "mock-video-v1".into(),
            display_name: "mock-video-v1".into(),
            capabilities: vec![Capability::VideoGeneration],
            endpoint: None,
            pricing: None,
            limits: None,
        },
    ];
    p
}

fn env_and_jobs() -> (std::path::PathBuf, Arc<AgentEnv>, Arc<JobManager>) {
    // 用手动临时目录避免 tempdir 生命周期问题
    let root = std::env::temp_dir().join(format!("onetv_golden_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let dir_audit = std::env::temp_dir().join(format!("onetv_golden_audit_{}", std::process::id()));
    let audit = Arc::new(onetv_security::audit::AuditLog::new(&dir_audit).unwrap());
    let policy = Arc::new(RwLock::new(onetv_security::NetworkPolicy::new(false)));
    let gateway = Arc::new(Gateway::new(policy, audit));
    let mut registry = ProviderRegistry::load(&root);
    registry.upsert(mock_provider());
    let registry = Arc::new(RwLock::new(registry));

    let sink: onetv_core::jobs::EventSink = Arc::new(|_n, _p| {});
    let jobs = JobManager::new(sink.clone());
    let env = AgentEnv::new(gateway, registry, onetv_media::MediaLocator::new(), sink);
    register_all_handlers(env.clone(), &jobs);
    jobs.set_project_root(Some(root.clone()));
    jobs.set_concurrency(4);
    (root, env, jobs)
}

fn wait_terminal(jobs: &Arc<JobManager>, ids: &[String], timeout: Duration) -> Vec<JobState> {
    let deadline = Instant::now() + timeout;
    loop {
        let all = jobs.list(200);
        let states: Vec<JobState> = ids
            .iter()
            .filter_map(|id| all.iter().find(|j| &j.id == id))
            .map(|j| j.state)
            .collect();
        if states.len() == ids.len() && states.iter().all(|s| s.is_terminal()) {
            return states;
        }
        if Instant::now() > deadline {
            panic!("任务超时未完成: {ids:?} 状态 {states:?}");
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn golden_pipeline_script_to_film() {
    let (root, env, jobs) = env_and_jobs();

    // 1. 创建项目 + 第一集（TC02）
    let (_h, mut manifest) = ops::create_project(&root, "霓虹夜行", "9:16").unwrap();
    let ep = ops::add_episode(&root, &mut manifest, None).unwrap();
    jobs.set_project_root(Some(root.clone()));

    let executor = Executor { env, jobs: jobs.clone() };

    // 2. Agent 生成剧本（Mock LLM，TC05）
    let plan = onetv_core::agent::build_plan(
        onetv_core::agent::Intent::ScriptGenerate,
        "都市情感短剧，雨夜咖啡店的秘密",
        Some(&ep.id),
    );
    let ids = executor.execute(&plan, &root, Some(ep.id.clone())).await.unwrap();
    assert_eq!(ids.len(), 1);
    let states = wait_terminal(&jobs, &ids, Duration::from_secs(60));
    assert!(states.iter().all(|s| *s == JobState::Succeeded), "剧本生成失败: {states:?}");

    let script: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("episodes").join(&ep.id).join("script.json")).unwrap(),
    )
    .unwrap();
    let scenes = script["scenes"].as_array().unwrap();
    assert!(!scenes.is_empty(), "剧本应有场景");

    // 3. 拆分镜头（本地工具）
    let plan2 = onetv_core::agent::build_plan(onetv_core::agent::Intent::StoryboardGenerate, "拆分镜头", Some(&ep.id));
    // 只执行第一步（shot.split + character.bind → storyboard.build job）
    let step_ids = executor
        .execute(
            &onetv_core::agent::Plan {
                steps: plan2.steps[..2].to_vec(),
                ..plan2.clone()
            },
            &root,
            Some(ep.id.clone()),
        )
        .await
        .unwrap();
    let states = wait_terminal(&jobs, &step_ids, Duration::from_secs(60));
    assert!(states.iter().all(|s| *s == JobState::Succeeded), "拆分镜头失败: {states:?}");

    let sb: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("episodes").join(&ep.id).join("storyboard.json")).unwrap(),
    )
    .unwrap();
    let shots = sb["shots"].as_array().unwrap().clone();
    assert!(shots.len() >= 4, "应有 ≥4 个镜头，实际 {}", shots.len());

    // 4. 批量生成分镜图（Mock 生图 + 资产入库，TC08/TC09）
    let plan3 = onetv_core::agent::build_plan(
        onetv_core::agent::Intent::StoryboardGenerate,
        "批量生成分镜图",
        Some(&ep.id),
    );
    let batch_step = plan3.steps.iter().find(|s| s.tool == "storyboard.image_batch").unwrap().clone();
    let batch_ids = executor
        .execute(
            &onetv_core::agent::Plan { steps: vec![batch_step], ..plan3.clone() },
            &root,
            Some(ep.id.clone()),
        )
        .await
        .unwrap();
    let states = wait_terminal(&jobs, &batch_ids, Duration::from_secs(180));
    assert!(states.iter().all(|s| *s == JobState::Succeeded), "批量分镜失败: {states:?}");

    let sb: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("episodes").join(&ep.id).join("storyboard.json")).unwrap(),
    )
    .unwrap();
    let with_output = sb["shots"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s.get("outputAssetId").is_some())
        .count();
    assert_eq!(with_output, shots.len(), "所有镜头都应有产物");

    // 5. 本地 FFmpeg 合成（TC10）
    let plan4 = onetv_core::agent::build_plan(onetv_core::agent::Intent::TimelineCompose, "合成", Some(&ep.id));
    let ids4 = executor.execute(&plan4, &root, Some(ep.id.clone())).await.unwrap();
    let states = wait_terminal(&jobs, &ids4, Duration::from_secs(300));
    assert!(states.iter().all(|s| *s == JobState::Succeeded), "合成失败: {states:?}");

    let renders = std::fs::read_dir(root.join("renders")).unwrap();
    let mp4s: Vec<_> = renders
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "mp4").unwrap_or(false))
        .collect();
    assert!(!mp4s.is_empty(), "应产出 MP4");

    // 6. 资产入库验证（TC09）；成片零拷贝登记：path 指向 renders/ 唯一副本，不复制进 assets/
    let assets = ops::list_assets(&root).unwrap();
    assert!(assets.iter().any(|a| a.kind == "images"), "分镜图应入库");
    let render_asset = assets.iter().find(|a| a.kind == "videos").expect("成片应入库");
    assert!(
        std::path::Path::new(&render_asset.path).starts_with(root.join("renders")),
        "成片资产应零拷贝指向 renders/: {}",
        render_asset.path
    );
    assert!(
        !assets
            .iter()
            .any(|a| a.kind == "videos" && std::path::Path::new(&a.path).starts_with(root.join("assets"))),
        "成片不应复制进 assets/"
    );

    // 7. 幂等：同参数任务不重复提交（规格 §11.2）
    let dup = jobs.create_job(
        onetv_core::jobs::JobKind::ImageGeneration,
        "重复任务",
        None,
        None,
        serde_json::json!({"prompt": "固定", "aspect": "9:16", "op": "x"}),
        None,
        None,
        false,
        None,
    );
    let dup2 = jobs.create_job(
        onetv_core::jobs::JobKind::ImageGeneration,
        "重复任务",
        None,
        None,
        serde_json::json!({"prompt": "固定", "aspect": "9:16", "op": "x"}),
        None,
        None,
        false,
        None,
    );
    assert_eq!(dup.id, dup2.id, "幂等键应复用同一任务");

    // 清理
    let _ = std::fs::remove_dir_all(&root);
}
