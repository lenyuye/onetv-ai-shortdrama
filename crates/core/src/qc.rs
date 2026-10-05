//! 自动 QC（v2.10）：视频产物的黑帧/静音/时长检测（规格 §14.1 最小集）。
//! 使用 FFmpeg blackdetect / silencedetect，纯本地执行，结果只做提示不拦截。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QcRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoQc {
    pub file: String,
    pub duration_sec: f64,
    pub black: Vec<QcRange>,
    pub silence: Vec<QcRange>,
    /// 是否含音轨（成片/导出无音轨通常是流程问题，v2.13）
    #[serde(default)]
    pub has_audio: bool,
}

impl VideoQc {
    /// 黑帧总时长
    pub fn black_total(&self) -> f64 {
        self.black.iter().map(|r| (r.end - r.start).max(0.0)).sum()
    }
    /// 静音总时长
    pub fn silence_total(&self) -> f64 {
        self.silence.iter().map(|r| (r.end - r.start).max(0.0)).sum()
    }
    /// 是否有值得关注的异常（黑帧>1s 或 片内静音>3s）
    pub fn has_issues(&self) -> bool {
        self.black_total() > 1.0 || self.silence_total() > 3.0
    }
}

fn media_bin(locator: &onetv_media::MediaLocator, ffmpeg: bool) -> Result<std::path::PathBuf, String> {
    let resolved = locator.resolve().map_err(|e| e.to_string())?;
    Ok(if ffmpeg { resolved.ffmpeg } else { resolved.ffprobe })
}

/// 探测是否含音频流
fn probe_has_audio(ffprobe: &std::path::Path, file: &std::path::Path) -> bool {
    std::process::Command::new(ffprobe)
        .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
        .arg(file)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// 探测时长（ffprobe format=duration）
fn probe_duration(ffprobe: &std::path::Path, file: &std::path::Path) -> Result<f64, String> {
    let out = std::process::Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(file)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim().parse::<f64>().map_err(|_| format!("无法解析时长: {text}"))
}

/// 解析 blackdetect stderr 行：`black_start:1.2 black_end:3.4 black_duration:2.2`
pub fn parse_blackdetect(stderr: &str) -> Vec<QcRange> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        if !line.contains("black_start:") {
            continue;
        }
        let get = |key: &str| {
            line.split(key).nth(1).and_then(|rest| {
                rest.split_whitespace().next().and_then(|v| v.trim_end_matches(',').parse::<f64>().ok())
            })
        };
        if let (Some(start), Some(end)) = (get("black_start:"), get("black_end:")) {
            out.push(QcRange { start, end });
        }
    }
    out
}

/// 解析 silencedetect stderr 行：`silence_start: 1.2` 与 `silence_end: 3.4 | ...`
pub fn parse_silencedetect(stderr: &str) -> Vec<QcRange> {
    let mut pending: Option<f64> = None;
    let mut out = Vec::new();
    for line in stderr.lines() {
        if let Some(rest) = line.split("silence_start:").nth(1) {
            if let Ok(v) = rest.trim().parse::<f64>() {
                pending = Some(v);
            }
        } else if let Some(rest) = line.split("silence_end:").nth(1) {
            if let Some(start) = pending.take() {
                let end = rest.split('|').next().and_then(|v| v.trim().parse::<f64>().ok());
                if let Some(end) = end {
                    out.push(QcRange { start, end });
                }
            }
        }
    }
    // 流末尾仍未结束的静音段：只保留起点（end=start，时长 0，不计入异常）
    if let Some(start) = pending {
        out.push(QcRange { start, end: start });
    }
    out
}

/// 对单个视频文件执行 QC。ffmpeg/ffprobe 均为本机绝对路径执行。
pub fn qc_video(locator: &onetv_media::MediaLocator, file: &std::path::Path) -> Result<VideoQc, String> {
    let ffmpeg = media_bin(locator, true)?;
    let ffprobe = media_bin(locator, false)?;
    let duration = probe_duration(&ffprobe, file)?;

    let run_filter = |filter: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostats", "-i"])
            .arg(file)
            .args(filter)
            .args(["-f", "null", "-"])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout)))
    };

    let black = parse_blackdetect(&run_filter(&["-vf", "blackdetect=d=0.5:pix_th=0.10", "-an"])?);
    let silence = parse_silencedetect(&run_filter(&["-af", "silencedetect=n=-40dB:d=2.0", "-vn"])?);
    let has_audio = probe_has_audio(&ffprobe, file);

    Ok(VideoQc {
        file: file.display().to_string(),
        duration_sec: duration,
        black,
        silence,
        has_audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blackdetect_lines() {
        let stderr = "[blackdetect @ 0x0] black_start:1.2 black_end:3.4 black_duration:2.2\n                      [blackdetect @ 0x0] black_start:10 black_end:10.6 black_duration:0.6";
        let ranges = parse_blackdetect(stderr);
        assert_eq!(ranges.len(), 2);
        assert!((ranges[0].start - 1.2).abs() < 1e-6);
        assert!((ranges[1].end - 10.6).abs() < 1e-6);
    }

    #[test]
    fn parse_silencedetect_lines() {
        let stderr = "[silencedetect @ 0x0] silence_start: 5.6\n                      [silencedetect @ 0x0] silence_end: 7.8 | silence_duration: 2.2\n                      [silencedetect @ 0x0] silence_start: 9\n";
        let ranges = parse_silencedetect(stderr);
        assert_eq!(ranges.len(), 2);
        assert!((ranges[0].end - 7.8).abs() < 1e-6);
        assert!((ranges[1].end - ranges[1].start).abs() < 1e-6, "未结束的静音段时长按 0 记");
    }

    #[test]
    fn qc_issues_threshold() {
        let qc = VideoQc {
            file: "x.mp4".into(),
            duration_sec: 10.0,
            black: vec![QcRange { start: 0.0, end: 1.5 }],
            silence: vec![],
            has_audio: true,
        };
        assert!(qc.has_issues());
        let ok = VideoQc { file: "y.mp4".into(), duration_sec: 10.0, black: vec![], silence: vec![], has_audio: true };
        assert!(!ok.has_issues());
    }
}
