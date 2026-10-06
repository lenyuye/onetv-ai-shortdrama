//! 多轨时间线渲染引擎（规格 §12.2，schemaVersion 2.0）。
//!
//! 与 `render` 的线性拼接（§12.1 分镜顺序 concat）不同：这里消费编辑器产出的
//! 多轨时间线文档——视频轨（多片段、trimIn/音量/淡入淡出、间隙黑场补齐）、
//! 多条音频轨（按 start 混音）、字幕轨（硬字幕/侧车），全部 FFmpeg 本机完成。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::render::{concat_clips, finalize, write_srt};
use crate::{MediaError, MediaLocator, MediaResult};

/// fade 转场固定时长（规格 §12.2：transitionIn/Out 只有 none|fade）
pub const FADE_SEC: f64 = 0.5;

/* ---------------- 时间线文档类型（契约钉死，camelCase 容错） ---------------- */

fn default_duration() -> f64 {
    3.0
}
fn default_volume() -> f64 {
    1.0
}
fn default_transition() -> String {
    "none".into()
}

/// 多轨时间线文档根（`episodes/<ep>/timeline.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelineSpec {
    pub schema_version: String,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub tracks: Vec<TimelineTrack>,
}

impl Default for TimelineSpec {
    fn default() -> Self {
        Self {
            schema_version: "2.0".into(),
            fps: 30,
            width: 1080,
            height: 1920,
            tracks: Vec::new(),
        }
    }
}

/// 单条轨道：video | audio | subtitle。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelineTrack {
    pub id: String,
    /// 轨道类型（"type" 是 Rust 关键字，出站仍写 type）
    #[serde(rename = "type")]
    pub kind: String,
    pub clips: Vec<TimelineClip>,
}

impl Default for TimelineTrack {
    fn default() -> Self {
        Self { id: String::new(), kind: "video".into(), clips: Vec::new() }
    }
}

/// 轨道内片段。trimIn 默认 0；volume 默认 1.0（0~2，video 轨 0 = 静音源音频）；
/// transitionIn/Out 只有 "none"|"fade"（fade 固定 0.5s）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelineClip {
    pub id: String,
    /// 资产 id（subtitle 轨片段为空）
    #[serde(default)]
    pub asset_id: String,
    /// 字幕轨片段文本
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start: f64,
    #[serde(default = "default_duration")]
    pub duration: f64,
    #[serde(default)]
    pub trim_in: f64,
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default = "default_transition")]
    pub transition_in: String,
    #[serde(default = "default_transition")]
    pub transition_out: String,
}

impl Default for TimelineClip {
    fn default() -> Self {
        Self {
            id: String::new(),
            asset_id: String::new(),
            text: String::new(),
            start: 0.0,
            duration: default_duration(),
            trim_in: 0.0,
            volume: default_volume(),
            transition_in: "none".into(),
            transition_out: "none".into(),
        }
    }
}

impl TimelineClip {
    fn is_fade_in(&self) -> bool {
        self.transition_in.eq_ignore_ascii_case("fade")
    }
    fn is_fade_out(&self) -> bool {
        self.transition_out.eq_ignore_ascii_case("fade")
    }
}

fn is_image_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("gif")
    )
}

fn is_finite_positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

/* ---------------- 渲染 ---------------- */

fn run(bin: &Path, args: &[&str]) -> MediaResult<()> {
    let status = std::process::Command::new(bin)
        .args(args)
        .status()
        .map_err(|e| MediaError::Spawn(e.to_string()))?;
    if !status.success() {
        return Err(MediaError::Spawn(format!(
            "FFmpeg 执行失败: {} {}",
            bin.display(),
            args.join(" ")
        )));
    }
    Ok(())
}

/// 归一化片段的统一编码参数（与 render.rs normalize_clip 一致，保证 concat 流复制可用）。
const NORM_VIDEO_ARGS: [&str; 8] = [
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
];

/// 黑场补隙片段（间隙不补内容，直接生成定长黑帧视频，保证 concat 后时间轴连续）。
fn render_black(
    locator: &MediaLocator,
    width: u32,
    height: u32,
    fps: u32,
    duration: f64,
    out: &Path,
) -> MediaResult<()> {
    let r = locator.resolve()?;
    let src = format!("color=c=black:s={width}x{height}:r={fps}:d={duration:.3}");
    let dur_s = format!("{duration:.3}");
    let out_s = out.to_str().ok_or_else(|| MediaError::Parse("路径非法".into()))?;
    let mut args: Vec<&str> = vec![
        "-y", "-v", "error", "-f", "lavfi", "-i", &src, "-t", &dur_s, "-an",
    ];
    args.extend(NORM_VIDEO_ARGS);
    args.push(out_s);
    run(&r.ffmpeg, &args)
}

/// 视频轨片段归一化：scale/pad 到目标画幅 + fps，扩展 trimIn/淡入淡出/源音量。
/// volume>0 且源有音轨时保留音频（-af volume=…），否则 -an（混音由独立 filter_complex 负责）。
#[allow(clippy::too_many_arguments)]
fn normalize_timeline_clip(
    locator: &MediaLocator,
    clip: &TimelineClip,
    src: &Path,
    src_is_image: bool,
    src_has_audio: bool,
    width: u32,
    height: u32,
    fps: u32,
    out: &Path,
) -> MediaResult<()> {
    let r = locator.resolve()?;
    let dur = clip.duration.max(0.1);
    let trim_s = format!("{:.3}", clip.trim_in);
    let dur_s = format!("{dur:.3}");
    let volume_s = format!("volume={:.3}", clip.volume.clamp(0.0, 2.0));
    // 淡入淡出（规格 §12.2：fade 固定 0.5s；fade=out 起点为 片段时长-0.5）
    let mut vf = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
    );
    if clip.is_fade_in() {
        vf.push_str(&format!(",fade=t=in:st=0:d={FADE_SEC}"));
    }
    if clip.is_fade_out() {
        vf.push_str(&format!(",fade=t=out:st={:.3}:d={FADE_SEC}", (dur - FADE_SEC).max(0.0)));
    }
    let src_s = src.to_str().ok_or_else(|| MediaError::Parse("路径非法".into()))?;
    let out_s = out.to_str().ok_or_else(|| MediaError::Parse("路径非法".into()))?;
    let mut args: Vec<&str> = vec!["-y", "-v", "error"];
    if src_is_image {
        // 图片资产：定长静帧（无 trimIn 概念）
        args.extend(["-loop", "1"]);
    } else if is_finite_positive(clip.trim_in) {
        args.extend(["-ss", &trim_s]);
    }
    args.push("-i");
    args.push(src_s);
    args.extend(["-t", &dur_s, "-vf", &vf]);
    let keep_audio = !src_is_image && clip.volume > 0.0 && src_has_audio;
    if keep_audio {
        args.extend(["-af", &volume_s, "-c:a", "aac", "-b:a", "160k"]);
    } else {
        args.push("-an");
    }
    args.extend(NORM_VIDEO_ARGS);
    args.push(out_s);
    run(&r.ffmpeg, &args)
}

/// 混音条目：一个参与混合的源片段（视频轨 volume>0 的片段或音频轨片段）。
struct MixEntry {
    path: PathBuf,
    trim_in: f64,
    duration: f64,
    volume: f64,
    /// 时间线起点（秒），adelay 用
    start: f64,
}

/// 把全部参与片段混成一条 wav：每个片段独立取窗（-ss trimIn -t duration），
/// `volume=v,adelay={start_ms}` 后 amix=inputs=N:normalize=0（音量不做二次归一）。
fn mix_audio(locator: &MediaLocator, entries: &[MixEntry], out_wav: &Path) -> MediaResult<()> {
    let r = locator.resolve()?;
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    for e in entries {
        if is_finite_positive(e.trim_in) {
            args.push("-ss".into());
            args.push(format!("{:.3}", e.trim_in));
        }
        args.push("-t".into());
        args.push(format!("{:.3}", e.duration.max(0.1)));
        args.push("-i".into());
        args.push(e.path.to_string_lossy().into_owned());
    }
    let mut chains: Vec<String> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        chains.push(format!(
            "[{i}:a]volume={:.3},adelay={}:all=1[a{i}]",
            e.volume.clamp(0.0, 2.0),
            (e.start.max(0.0) * 1000.0).round() as i64
        ));
        labels.push(format!("[a{i}]"));
    }
    let graph = format!(
        "{};{}amix=inputs={}:normalize=0[aout]",
        chains.join(";"),
        labels.join(""),
        entries.len()
    );
    args.push("-filter_complex".into());
    args.push(graph);
    args.push("-map".into());
    args.push("[aout]".into());
    args.extend(["-c:a".into(), "pcm_s16le".into(), "-ar".into(), "44100".into(), "-ac".into(), "2".into()]);
    args.push(out_wav.to_string_lossy().into_owned());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(&r.ffmpeg, &refs)
}

/// 渲染结果：成片路径 + 字幕 SRT 路径（位于 work_dir，handler 复制为侧车）。
#[derive(Debug)]
pub struct TimelineRenderOutput {
    pub video: PathBuf,
    pub srt: PathBuf,
}

/// 多轨时间线渲染主入口（规格 §12.2）：
/// 视频轨片段归一化（间隙黑场补齐）→ concat → 全轨混音 → 字幕/音轨 finalize。
///
/// * `resolver`：assetId → 本地文件路径（handlers 侧查 sqlite assets 表）。
/// * `on_progress`：normalize 阶段 0~0.6，混音 0.7，finalize 0.85，完成 1.0。
pub fn render_timeline(
    locator: &MediaLocator,
    spec: &TimelineSpec,
    resolver: &dyn Fn(&str) -> Option<PathBuf>,
    out: &Path,
    work_dir: &Path,
    on_progress: &dyn Fn(f64, &str),
) -> MediaResult<TimelineRenderOutput> {
    std::fs::create_dir_all(work_dir).map_err(MediaError::Io)?;

    // ── 1. 视频轨：取第一条 video 轨 ──
    let video_track = spec
        .tracks
        .iter()
        .find(|t| t.kind == "video")
        .ok_or_else(|| MediaError::Parse("时间线没有视频轨，无法合成（请在时间线中添加视频轨道）".into()))?;
    if video_track.clips.is_empty() {
        return Err(MediaError::Parse("视频轨没有任何片段，无法合成（先在时间线中排列镜头）".into()));
    }
    let mut clips: Vec<TimelineClip> = video_track.clips.clone();
    clips.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    // 解析资产路径 + 源媒体探测缓存（是否有音轨/是否图片）
    let mut probe_cache: HashMap<PathBuf, bool> = HashMap::new();
    let mut resolved: Vec<(TimelineClip, PathBuf)> = Vec::with_capacity(clips.len());
    for clip in clips {
        let path = resolver(&clip.asset_id).ok_or_else(|| {
            MediaError::Parse(format!("找不到片段 {} 引用的资产 {}（可能已被删除）", clip.id, clip.asset_id))
        })?;
        if !path.exists() {
            return Err(MediaError::Parse(format!(
                "资产 {} 的文件不存在: {}",
                clip.asset_id,
                path.display()
            )));
        }
        resolved.push((clip, path));
    }

    let (width, height, fps) = (spec.width.max(2), spec.height.max(2), spec.fps.max(1));

    // ── 2. 归一化：按 start 排序逐段处理，间隙用黑场补齐保证时间轴连续 ──
    let total_clips = resolved.len();
    let mut segments: Vec<PathBuf> = Vec::new();
    let mut cursor = 0.0f64;
    for (i, (clip, path)) in resolved.iter().enumerate() {
        let start = clip.start.max(0.0);
        if start > cursor + 0.01 {
            let gap = start - cursor;
            let p = work_dir.join(format!("gap_{i:04}.mp4"));
            on_progress(0.6 * (i as f64 / total_clips.max(1) as f64), &format!("补齐黑场间隙 {gap:.1}s…"));
            render_black(locator, width, height, fps, gap, &p)?;
            segments.push(p);
            cursor = start;
        }
        let src_is_image = is_image_path(path);
        let src_has_audio = if src_is_image {
            false
        } else {
            *probe_cache.entry(path.clone()).or_insert_with(|| {
                crate::probe(locator, path).map(|info| info.has_audio).unwrap_or(false)
            })
        };
        on_progress(
            0.6 * (i as f64 / total_clips.max(1) as f64),
            &format!("归一化片段 {}/{}…", i + 1, total_clips),
        );
        let seg = work_dir.join(format!("clip_{i:04}.mp4"));
        normalize_timeline_clip(locator, clip, path, src_is_image, src_has_audio, width, height, fps, &seg)?;
        segments.push(seg);
        cursor = cursor.max(start + clip.duration.max(0.1));
    }

    // ── 3. 字幕轨：clips → cues（多条字幕轨合并） ──
    let mut cues: Vec<(f64, f64, String)> = Vec::new();
    for track in &spec.tracks {
        if track.kind != "subtitle" {
            continue;
        }
        for c in &track.clips {
            let text = c.text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let start = c.start.max(0.0);
            cues.push((start, start + c.duration.max(0.1), text));
        }
    }
    cues.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let srt_path = work_dir.join("subs.srt");
    if !cues.is_empty() {
        write_srt(&cues, &srt_path)?;
    }

    // ── 4. concat（参数一致的片段流复制拼接） ──
    if segments.is_empty() {
        return Err(MediaError::Parse("没有可合成的视频片段".into()));
    }
    on_progress(0.65, "拼接视频段…");
    let concated = work_dir.join("concat.mp4");
    concat_clips(locator, &segments, &concated)?;

    // ── 5. 混音：视频轨 volume>0 的片段 + 全部音频轨片段 ──
    let mut entries: Vec<MixEntry> = Vec::new();
    for (clip, path) in &resolved {
        if !is_image_path(path) && clip.volume > 0.0 {
            // 源是否有音轨已在归一化阶段探测
            let has_audio = *probe_cache.entry(path.clone()).or_insert_with(|| {
                crate::probe(locator, path).map(|info| info.has_audio).unwrap_or(false)
            });
            if has_audio {
                entries.push(MixEntry {
                    path: path.clone(),
                    trim_in: clip.trim_in,
                    duration: clip.duration.max(0.1),
                    volume: clip.volume,
                    start: clip.start.max(0.0),
                });
            }
        }
    }
    for track in &spec.tracks {
        if track.kind != "audio" {
            continue;
        }
        for c in &track.clips {
            if c.asset_id.is_empty() || !is_finite_positive(c.duration) {
                continue;
            }
            let Some(path) = resolver(&c.asset_id) else {
                return Err(MediaError::Parse(format!(
                    "找不到音频片段 {} 引用的资产 {}",
                    c.id, c.asset_id
                )));
            };
            if !path.exists() {
                return Err(MediaError::Parse(format!(
                    "音频资产 {} 的文件不存在: {}",
                    c.asset_id,
                    path.display()
                )));
            }
            entries.push(MixEntry {
                path,
                trim_in: c.trim_in,
                duration: c.duration.max(0.1),
                volume: c.volume.clamp(0.0, 2.0),
                start: c.start.max(0.0),
            });
        }
    }
    let mixed_wav = work_dir.join("mix.wav");
    let mixed = if entries.is_empty() {
        None
    } else {
        on_progress(0.7, &format!("混音 {} 路音频…", entries.len()));
        mix_audio(locator, &entries, &mixed_wav)?;
        Some(mixed_wav)
    };

    // ── 6. finalize：硬字幕（无 libass 自动降级软字幕）+ 混音轨 mux ──
    on_progress(0.85, "合成成片（字幕/音轨）…");
    finalize(
        locator,
        &concated,
        if cues.is_empty() { None } else { Some(srt_path.as_path()) },
        mixed.as_deref(),
        out,
    )?;
    on_progress(1.0, "时间线渲染完成");
    Ok(TimelineRenderOutput { video: out.to_path_buf(), srt: srt_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------------- 类型反序列化 ---------------- */

    #[test]
    fn deserializes_camel_case_with_defaults() {
        let raw = serde_json::json!({
            "schemaVersion": "2.0", "fps": 30, "width": 1080, "height": 1920,
            "tracks": [
                {"id": "v1", "type": "video", "clips": [
                    {"id": "c1", "assetId": "asset-a", "start": 0.0, "duration": 5.0},
                    {"id": "c2", "assetId": "asset-b", "start": 5.0, "duration": 4.0,
                     "trimIn": 1.5, "volume": 0.5, "transitionIn": "none", "transitionOut": "fade"}
                ]},
                {"id": "a1", "type": "audio", "clips": [
                    {"id": "a2", "assetId": "asset-c", "start": 0.0, "duration": 5.0, "volume": 0.8}
                ]},
                {"id": "sub1", "type": "subtitle", "clips": [
                    {"id": "s1", "text": "台词", "start": 2.1, "duration": 1.8}
                ]}
            ]
        });
        let spec: TimelineSpec = serde_json::from_value(raw).unwrap();
        assert_eq!(spec.schema_version, "2.0");
        assert_eq!(spec.fps, 30);
        assert_eq!(spec.tracks.len(), 3);
        let c1 = &spec.tracks[0].clips[0];
        assert_eq!(c1.asset_id, "asset-a");
        assert_eq!(c1.trim_in, 0.0, "trimIn 缺省应为 0");
        assert_eq!(c1.volume, 1.0, "volume 缺省应为 1.0");
        assert_eq!(c1.transition_in, "none");
        assert_eq!(c1.transition_out, "none");
        let c2 = &spec.tracks[0].clips[1];
        assert_eq!(c1.volume, 1.0);
        assert_eq!(c2.trim_in, 1.5);
        assert_eq!(c2.volume, 0.5);
        assert!(c2.is_fade_out());
        assert!(!c2.is_fade_in());
        assert_eq!(spec.tracks[2].clips[0].text, "台词");
    }

    #[test]
    fn missing_top_level_fields_fall_back() {
        let raw = serde_json::json!({
            "tracks": [{"id": "v", "type": "video", "clips": [
                {"id": "c", "assetId": "a", "start": 0.0, "duration": 1.0}
            ]}]
        });
        let spec: TimelineSpec = serde_json::from_value(raw).unwrap();
        assert_eq!(spec.fps, 30);
        assert_eq!(spec.width, 1080);
        assert_eq!(spec.height, 1920);
        assert_eq!(spec.tracks[0].clips[0].volume, 1.0);
    }

    #[test]
    fn round_trips_to_camel_case_json() {
        let mut clip = TimelineClip::default();
        clip.trim_in = 0.5;
        let v = serde_json::to_value(&clip).unwrap();
        assert!(v.get("trimIn").is_some(), "出站必须是 camelCase");
        assert!(v.get("assetId").is_some());
        assert!(v.get("transitionIn").is_some());
        let spec = TimelineSpec::default();
        let v = serde_json::to_value(&spec).unwrap();
        assert_eq!(v.get("schemaVersion").and_then(|x| x.as_str()), Some("2.0"));
    }

    /* ---------------- FFmpeg 集成（本机无 ffmpeg 时跳过） ---------------- */

    fn test_video(dir: &Path, name: &str, src_filter: &str) -> PathBuf {
        let locator = MediaLocator::new();
        let r = locator.resolve().expect("测试前提：本机有 ffmpeg");
        let out = dir.join(name);
        let status = std::process::Command::new(&r.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", src_filter])
            .args(["-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success(), "生成测试视频失败: {name}");
        out
    }

    fn test_wav(dir: &Path, name: &str) -> PathBuf {
        let locator = MediaLocator::new();
        let r = locator.resolve().expect("测试前提：本机有 ffmpeg");
        let out = dir.join(name);
        let status = std::process::Command::new(&r.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"])
            .args(["-t", "2", "-c:a", "pcm_s16le"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success(), "生成测试音频失败");
        out
    }

    fn ffmpeg_available() -> bool {
        MediaLocator::new().resolve().is_ok()
    }

    #[test]
    fn renders_multi_track_timeline() {
        if !ffmpeg_available() {
            println!("跳过：本机无 ffmpeg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let v1 = test_video(dir.path(), "v1.mp4", "testsrc=size=320x480:rate=30");
        let v2 = test_video(dir.path(), "v2.mp4", "smptebars=size=320x480:rate=30");
        let wav = test_wav(dir.path(), "a1.wav");

        let spec_json = serde_json::json!({
            "schemaVersion": "2.0", "fps": 30, "width": 320, "height": 480,
            "tracks": [
                {"id": "v1", "type": "video", "clips": [
                    {"id": "c1", "assetId": "asset-v1", "start": 0.0, "duration": 2.0, "volume": 1.0},
                    {"id": "c2", "assetId": "asset-v2", "start": 2.0, "duration": 2.0,
                     "volume": 0.5, "transitionOut": "fade"}
                ]},
                {"id": "a1", "type": "audio", "clips": [
                    {"id": "a2", "assetId": "asset-wav", "start": 1.0, "duration": 2.0, "volume": 0.8}
                ]},
                {"id": "sub1", "type": "subtitle", "clips": [
                    {"id": "s1", "text": "你好时间线", "start": 1.0, "duration": 1.5}
                ]}
            ]
        });
        let spec: TimelineSpec = serde_json::from_value(spec_json).unwrap();

        let v1c = v1.clone();
        let v2c = v2.clone();
        let wavc = wav.clone();
        let resolver = move |id: &str| -> Option<PathBuf> {
            match id {
                "asset-v1" => Some(v1c.clone()),
                "asset-v2" => Some(v2c.clone()),
                "asset-wav" => Some(wavc.clone()),
                _ => None,
            }
        };
        let out = dir.path().join("out.mp4");
        let work = dir.path().join("work");
        let result = render_timeline(
            &MediaLocator::new(),
            &spec,
            &resolver,
            &out,
            &work,
            &|_p, _m| {}, // 进度回调连通性由补隙用例断言
        )
        .unwrap();
        assert!(result.video.exists(), "成片应存在");
        assert!(result.srt.exists(), "SRT 应存在");
        assert!(out.to_string_lossy().contains("out.mp4"));

        // 视频轨总长 4s；混音窗 1~3s，finalize -shortest 截到 ≈3s
        let locator = MediaLocator::new();
        let info = crate::probe(&locator, &out).unwrap();
        assert!(
            (2.3..=3.7).contains(&info.duration_sec),
            "时长应 ≈3s±0.7，实际 {}",
            info.duration_sec
        );
        assert!(info.width == Some(320) && info.height == Some(480), "画幅应归一化");
        assert!(info.has_audio, "混音后应有音频流");
    }

    #[test]
    fn black_gap_between_clips_extends_duration() {
        if !ffmpeg_available() {
            println!("跳过：本机无 ffmpeg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let v1 = test_video(dir.path(), "g1.mp4", "testsrc=size=320x480:rate=30");
        let v2 = test_video(dir.path(), "g2.mp4", "smptebars=size=320x480:rate=30");

        // clip1 0~2s，clip2 start=3（duration 1s）→ 1s 黑场补隙，总长 ≈4s
        let spec_json = serde_json::json!({
            "schemaVersion": "2.0", "fps": 30, "width": 320, "height": 480,
            "tracks": [
                {"id": "v1", "type": "video", "clips": [
                    {"id": "c1", "assetId": "asset-v1", "start": 0.0, "duration": 2.0, "volume": 0.0},
                    {"id": "c2", "assetId": "asset-v2", "start": 3.0, "duration": 1.0, "volume": 0.0}
                ]}
            ]
        });
        let spec: TimelineSpec = serde_json::from_value(spec_json).unwrap();
        let v1c = v1.clone();
        let v2c = v2.clone();
        let resolver = move |id: &str| -> Option<PathBuf> {
            match id {
                "asset-v1" => Some(v1c.clone()),
                "asset-v2" => Some(v2c.clone()),
                _ => None,
            }
        };
        let out = dir.path().join("out_gap.mp4");
        let work = dir.path().join("work_gap");
        let last_progress = std::sync::atomic::AtomicU64::new(0);
        render_timeline(&MediaLocator::new(), &spec, &resolver, &out, &work, &|p, _| {
            last_progress.store(p.to_bits(), std::sync::atomic::Ordering::Relaxed);
        })
        .unwrap();
        assert!(out.exists());
        let final_progress = f64::from_bits(last_progress.load(std::sync::atomic::Ordering::Relaxed));
        assert!((final_progress - 1.0).abs() < 1e-6, "结束时应回调 1.0");

        let locator = MediaLocator::new();
        let info = crate::probe(&locator, &out).unwrap();
        assert!(
            (3.3..=4.7).contains(&info.duration_sec),
            "黑场补隙后时长应 ≈4s，实际 {}",
            info.duration_sec
        );
    }

    #[test]
    fn empty_video_track_is_a_parse_error() {
        let locator = MediaLocator::new();
        let spec: TimelineSpec = serde_json::from_value(serde_json::json!({
            "schemaVersion": "2.0", "fps": 30, "width": 320, "height": 480,
            "tracks": [{"id": "v1", "type": "video", "clips": []}]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let no_resolver = |_: &str| -> Option<PathBuf> { None };
        let r = render_timeline(
            &locator,
            &spec,
            &no_resolver,
            &dir.path().join("out.mp4"),
            &dir.path().join("work"),
            &|_, _| {},
        );
        match r {
            Err(MediaError::Parse(msg)) => assert!(msg.contains("视频轨"), "中文报错应指明视频轨为空: {msg}"),
            other => panic!("应返回 Parse 错误，实际: {other:?}"),
        }
    }
}
