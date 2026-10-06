//! FFmpeg / FFprobe 本地媒体引擎封装（规格 §3.1 / §12.1）。
//!
//! 核心成片不依赖云端：拼接、转码、混音、字幕、封面、画幅版本全部在本机完成。

pub mod render;
pub mod timeline;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("未找到 FFmpeg：已在 PATH、/usr/local/bin、/opt/homebrew/bin 中未找到 ffmpeg，可在设置中手动指定路径")]
    NotFound,
    #[error("FFmpeg 执行失败: {0}")]
    Spawn(String),
    #[error("媒体解析失败: {0}")]
    Parse(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
}

pub type MediaResult<T> = Result<T, MediaError>;

/// FFmpeg 可执行文件定位器（设置覆盖 > PATH > /usr/local/bin > /opt/homebrew/bin > /usr/bin）。
#[derive(Clone)]
pub struct MediaLocator {
    override_ffmpeg: Arc<RwLock<Option<PathBuf>>>,
    override_ffprobe: Arc<RwLock<Option<PathBuf>>>,
    cached: Arc<RwLock<Option<ResolvedPaths>>>,
    filters: Arc<RwLock<Option<std::collections::HashSet<String>>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub version: Option<String>,
}

impl MediaLocator {
    pub fn new() -> Self {
        Self {
            override_ffmpeg: Arc::new(RwLock::new(None)),
            override_ffprobe: Arc::new(RwLock::new(None)),
            cached: Arc::new(RwLock::new(None)),
            filters: Arc::new(RwLock::new(None)),
        }
    }

    /// 探测 ffmpeg 是否支持某滤镜（如 subtitles/drawtext；libass 缺失的构建会回退）。
    pub fn has_filter(&self, name: &str) -> bool {
        let mut cached = self.filters.write();
        if cached.is_none() {
            let Ok(r) = self.resolve() else { return false };
            let Ok(out) = std::process::Command::new(&r.ffmpeg)
                .args(["-hide_banner", "-filters"])
                .output()
            else {
                return false;
            };
            let text = String::from_utf8_lossy(&out.stdout);
            let set = text
                .lines()
                .filter_map(|l| l.split_whitespace().nth(1).map(|s| s.to_string()))
                .collect::<std::collections::HashSet<_>>();
            *cached = Some(set);
        }
        cached.as_ref().map(|s| s.contains(name)).unwrap_or(false)
    }

    pub fn set_overrides(&self, ffmpeg: Option<PathBuf>, ffprobe: Option<PathBuf>) {
        *self.override_ffmpeg.write() = ffmpeg;
        *self.override_ffprobe.write() = ffprobe;
        *self.cached.write() = None;
    }

    pub fn resolve(&self) -> MediaResult<ResolvedPaths> {
        if let Some(c) = self.cached.read().clone() {
            return Ok(c);
        }
        let ffmpeg = self
            .override_ffmpeg.read()
            .clone()
            .or_else(|| find_binary("ffmpeg"))
            .ok_or(MediaError::NotFound)?;
        let ffprobe = self
            .override_ffprobe
            .read()
            .clone()
            .or_else(|| find_binary("ffprobe"))
            .ok_or(MediaError::NotFound)?;
        let version = probe_version(&ffmpeg);
        let resolved = ResolvedPaths { ffmpeg, ffprobe, version };
        *self.cached.write() = Some(resolved.clone());
        Ok(resolved)
    }
}

impl Default for MediaLocator {
    fn default() -> Self {
        Self::new()
    }
}

/// 定位可执行文件：裸名/PATH 环境 → /usr/local/bin → /opt/homebrew/bin → /usr/bin。
/// GUI 应用不继承 shell 的 PATH，且仅 stat 文件可能漏掉符号链接失效/无执行权限的情况，
/// 因此候选路径用真实执行（`<bin> -version`）验证，能运行才算找到。
fn find_binary(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from(name)];
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            candidates.push(PathBuf::from(dir).join(name));
        }
    }
    for base in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        candidates.push(PathBuf::from(base).join(name));
    }
    for p in candidates {
        if runs_ok(&p) {
            return Some(p);
        }
    }
    None
}

/// 真实执行 `<bin> -version` 确认可用（ffmpeg/ffprobe 均支持 -version）。
fn runs_ok(bin: &Path) -> bool {
    std::process::Command::new(bin)
        .arg("-version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn probe_version(ffmpeg: &Path) -> Option<String> {
    let out = std::process::Command::new(ffmpeg)
        .arg("-version")
        .output()
        .ok()?;
    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    first.split_whitespace().nth(2).map(|s| s.to_string())
}

/* ---------------- probe ---------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaInfo {
    pub duration_sec: f64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_audio: bool,
    pub size_bytes: u64,
    pub format: Option<String>,
}

impl MediaInfo {
    pub fn aspect_ratio(&self) -> Option<f64> {
        Some(self.width? as f64 / self.height? as f64)
    }
}

/// ffprobe 元数据读取（时长/分辨率/编码/音频）。
pub fn probe(locator: &MediaLocator, path: &Path) -> MediaResult<MediaInfo> {
    let resolved = locator.resolve()?;
    let out = std::process::Command::new(&resolved.ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|e| MediaError::Spawn(e.to_string()))?;

    if !out.status.success() {
        return Err(MediaError::Parse(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| MediaError::Parse(e.to_string()))?;

    let mut info = MediaInfo {
        duration_sec: v["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        size_bytes: v["format"]["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        format: v["format"]["format_name"].as_str().map(|s| s.to_string()),
        ..Default::default()
    };

    if let Some(streams) = v["streams"].as_array() {
        for s in streams {
            match s["codec_type"].as_str() {
                Some("video") if info.width.is_none() => {
                    info.width = s["width"].as_u64().map(|x| x as u32);
                    info.height = s["height"].as_u64().map(|x| x as u32);
                    info.video_codec = s["codec_name"].as_str().map(|s| s.to_string());
                    info.fps = parse_fps(
                        s["avg_frame_rate"].as_str().or_else(|| s["r_frame_rate"].as_str()),
                    );
                }
                Some("audio") => {
                    info.has_audio = true;
                    if info.audio_codec.is_none() {
                        info.audio_codec = s["codec_name"].as_str().map(|s| s.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

fn parse_fps(s: Option<&str>) -> Option<f64> {
    let s = s?;
    let (a, b) = s.split_once('/')?;
    let a: f64 = a.parse().ok()?;
    let b: f64 = b.parse().ok()?;
    if b == 0.0 {
        None
    } else {
        Some(a / b)
    }
}

/// 生成缩略图（第一帧/指定时刻），返回输出路径。
pub fn thumbnail(
    locator: &MediaLocator,
    video: &Path,
    at_sec: f64,
    out_png: &Path,
    max_width: u32,
) -> MediaResult<PathBuf> {
    let resolved = locator.resolve()?;
    let status = std::process::Command::new(&resolved.ffmpeg)
        .args(["-y", "-v", "error", "-ss", &format!("{at_sec:.3}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("scale='min({max_width},iw)':-2")])
        .arg(out_png)
        .status()
        .map_err(|e| MediaError::Spawn(e.to_string()))?;
    if !status.success() {
        return Err(MediaError::Spawn("thumbnail 生成失败".into()));
    }
    Ok(out_png.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fps_fraction() {
        assert_eq!(parse_fps(Some("30/1")), Some(30.0));
        assert_eq!(parse_fps(Some("2997/100")), Some(29.97));
        assert_eq!(parse_fps(Some("0/0")), None);
    }

    #[cfg(feature = "integration")]
    #[test]
    fn probe_real_file() {
        // 需要系统 ffmpeg；CI 有 FFmpeg 8.1
        let locator = MediaLocator::new();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("t.mp4");
        let r = locator.resolve().unwrap();
        let status = std::process::Command::new(&r.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success());
        let info = probe(&locator, &out).unwrap();
        assert!(info.duration_sec > 0.5);
        assert_eq!(info.width, Some(64));
    }
}
