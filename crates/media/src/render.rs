//! 本地时间线渲染引擎（规格 §12.1）：拼接/转码/字幕/画幅版本，全部 FFmpeg 本机完成。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::MediaLocator;
use crate::MediaError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipSource {
    pub path: PathBuf,
    pub is_image: bool,
    pub duration: f64,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub clips: Vec<ClipSource>,
    /// 硬字幕 SRT（可选）
    pub subtitle_srt: Option<PathBuf>,
    /// 附加音轨（可选，如配音）
    pub audio: Option<PathBuf>,
    pub crf: u32,
}

fn run(bin: &Path, args: &[&str]) -> Result<(), MediaError> {
    let status = std::process::Command::new(bin)
        .args(args)
        .status()
        .map_err(|e| MediaError::Spawn(e.to_string()))?;
    if !status.success() {
        return Err(MediaError::Spawn(format!("FFmpeg 执行失败: {} {}", bin.display(), args.join(" "))));
    }
    Ok(())
}

/// 图片 → 定长视频片段（缩放补边到目标画幅）。
pub fn normalize_clip(
    locator: &MediaLocator,
    clip: &ClipSource,
    spec_w: u32,
    spec_h: u32,
    fps: u32,
    out: &Path,
) -> Result<(), MediaError> {
    let r = locator.resolve()?;
    let vf = format!(
        "scale={spec_w}:{spec_h}:force_original_aspect_ratio=decrease,pad={spec_w}:{spec_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
    );
    if clip.is_image {
        run(
            &r.ffmpeg,
            &[
                "-y", "-v", "error",
                "-loop", "1",
                "-i", clip.path.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
                "-t", &format!("{:.2}", clip.duration),
                "-vf", &vf,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
                "-an",
                out.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
            ],
        )
    } else {
        run(
            &r.ffmpeg,
            &[
                "-y", "-v", "error",
                "-i", clip.path.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
                "-t", &format!("{:.2}", clip.duration),
                "-vf", &vf,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
                "-an",
                out.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
            ],
        )
    }
}

/// concat demuxer 拼接已归一化片段（参数一致，流复制零转码）。
pub fn concat_clips(locator: &MediaLocator, clips: &[PathBuf], out: &Path) -> Result<(), MediaError> {
    let r = locator.resolve()?;
    let dir = out.parent().ok_or(MediaError::Parse("输出路径非法".into()))?;
    let list_path = dir.join("concat_list.txt");
    let mut list = String::new();
    for c in clips {
        // ffmpeg concat 转义：路径里的单引号写成 '\''（v2.12.0 修复）
        let escaped = c.display().to_string().replace('\'', "'\\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list).map_err(MediaError::Io)?;
    run(
        &r.ffmpeg,
        &[
            "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", list_path.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
            "-c", "copy",
            out.to_str().ok_or(MediaError::Parse("路径非法".into()))?,
        ],
    )
}

/// 硬字幕烧录（需 libass）+ 可选音轨混入；无 libass 时降级为软字幕轨。
pub fn finalize(
    locator: &MediaLocator,
    input: &Path,
    srt: Option<&Path>,
    audio: Option<&Path>,
    out: &Path,
) -> Result<(), MediaError> {
    let r = locator.resolve()?;
    let can_burn = srt.is_some() && locator.has_filter("subtitles");
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into(), "-i".into(), input.to_string_lossy().into_owned()];
    let has_audio = audio.is_some();
    if let Some(a) = audio {
        args.push("-i".into());
        args.push(a.to_string_lossy().into_owned());
    }
    // 软字幕轨（libass 缺失时的降级；SRT 侧车始终另行输出）
    let mut srt_input: Option<&Path> = None;
    if let Some(s) = srt {
        if can_burn {
            let escaped = s.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'");
            args.push("-vf".into());
            args.push(format!("subtitles='{escaped}'"));
        } else {
            srt_input = Some(s);
            args.push("-i".into());
            args.push(s.to_string_lossy().into_owned());
        }
    }
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push("20".into());
    if has_audio {
        args.push("-map".into());
        args.push("0:v:0".into());
        args.push("-map".into());
        args.push("1:a:0".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-shortest".into());
    }
    if srt_input.is_some() {
        if !has_audio {
            args.push("-map".into());
            args.push("0:v:0".into());
        }
        args.push("-map".into());
        args.push(format!("{}:s:0", if has_audio { 2 } else { 1 }));
        args.push("-c:s".into());
        args.push("mov_text".into());
        args.push("-metadata:s:s:0".into());
        args.push("language=chi".into());
    }
    if !has_audio && srt_input.is_none() {
        args.push("-an".into());
    }
    args.push(out.to_string_lossy().into_owned());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(&r.ffmpeg, &refs)
}

/// 由 cue 列表生成 SRT。
pub fn write_srt(cues: &[(f64, f64, String)], path: &Path) -> Result<(), MediaError> {
    let fmt = |t: f64| {
        let h = (t / 3600.0).floor() as u32;
        let m = ((t % 3600.0) / 60.0).floor() as u32;
        let s = (t % 60.0).floor() as u32;
        let ms = ((t - t.floor()) * 1000.0) as u32;
        format!("{h:02}:{m:02}:{s:02},{ms:03}")
    };
    let mut content = String::new();
    for (i, (start, end, text)) in cues.iter().enumerate() {
        content.push_str(&format!("{}\n{} --> {}\n{}\n\n", i + 1, fmt(*start), fmt(*end), text));
    }
    std::fs::write(path, content).map_err(MediaError::Io)
}

/// 导出预设（规格 §12.3）。
pub fn preset_size(preset: &str) -> (u32, u32) {
    match preset {
        "horizontal_1080p" => (1920, 1080),
        "xhs_vertical" => (1080, 1440),
        "square" => (1080, 1080),
        "master" => (0, 0), // 保持源
        _ => (1080, 1920),  // douyin_vertical
    }
}

/// 整体渲染管线：normalize → concat → (字幕/音轨) finalize。
pub fn compose(locator: &MediaLocator, spec: &RenderSpec, out: &Path, work_dir: &Path) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(work_dir).map_err(MediaError::Io)?;
    let mut normalized = Vec::new();
    for (i, clip) in spec.clips.iter().enumerate() {
        let np = work_dir.join(format!("clip_{i:04}.mp4"));
        normalize_clip(locator, clip, spec.width, spec.height, spec.fps, &np)?;
        normalized.push(np);
    }
    if normalized.is_empty() {
        return Err(MediaError::Parse("没有可合成的镜头（先完成生成步骤）".into()));
    }
    let concated = work_dir.join("concat.mp4");
    concat_clips(locator, &normalized, &concated)?;

    if spec.subtitle_srt.is_none() && spec.audio.is_none() {
        std::fs::rename(&concated, out).map_err(MediaError::Io)?;
        return Ok(out.to_path_buf());
    }
    finalize(
        locator,
        &concated,
        spec.subtitle_srt.as_deref(),
        spec.audio.as_deref(),
        out,
    )?;
    Ok(out.to_path_buf())
}
