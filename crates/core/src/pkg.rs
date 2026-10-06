//! 工程包导入导出（规格 §16/§20 TC13）：.ytv → .ytv.zip，另一台机器可恢复。
//! 可选加密（ONETVENC1）：明文 zip 字节流整体 AES-256-GCM 加密后落盘。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use onetv_project::manifest::ProjectManifest;

#[derive(Debug, thiserror::Error)]
pub enum PkgError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Invalid(String),
    /// 加密工程包未提供密码（命令层据此返回 needsPassphrase 给前端）。
    #[error("此工程包已加密，需要密码")]
    PassphraseRequired,
    /// 密码错误，或魔数/GCM tag 校验失败（无法区分是哪一种）。
    #[error("密码错误或文件已损坏")]
    BadPassphrase,
}

/// 排除项：渲染缓存与日志（工程数据都在 JSON/SQLite/资产里）。
fn excluded(rel: &str) -> bool {
    rel.starts_with("renders/") || rel.starts_with("logs/") || rel.ends_with(".sqlite-wal") || rel.ends_with(".sqlite-shm")
}

/* ---------------- ONETVENC1 加密工程包 ----------------
 * 布局：ONETVENC1(8B) || salt(16B) || nonce(12B) || AES-256-GCM 密文(含 16B tag)。
 * 密钥：PBKDF2-HMAC-SHA256，120_000 轮，输出 32 字节。
 * 解密时校验魔数与 GCM tag，任一失败报「密码错误或文件已损坏」。
 */

/// 注意：字面量 "ONETVENC1" 为 9 字节（设计文档写 8 字节系笔误），以完整字符串为准。
pub const ENC_MAGIC: [u8; 9] = *b"ONETVENC1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const PBKDF2_ITERS: u32 = 120_000;

/// 文件前 8 字节是否为加密工程包魔数（导入侧自动探测依据）。
pub fn is_encrypted_file(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; ENC_MAGIC.len()];
    matches!(f.read_exact(&mut magic), Ok(())) && magic == ENC_MAGIC
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERS, &mut key);
    key
}

/// 明文字节流 → ONETVENC1 加密流。
/// 限制：GCM 单次认证要求密文整体驻留内存（与导入侧 2GB 解压上限同量级）；
/// 调用方（export_project）先流式落临时 zip 再调用本函数，zip 打包阶段不占大内存。
pub fn encrypt_stream(mut plain: impl Read, mut out: impl Write, passphrase: &str) -> Result<(), PkgError> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut data = Vec::new();
    plain.read_to_end(&mut data)?;
    let cipher = Aes256Gcm::new((&derive_key(passphrase, &salt)).into());
    let ct = cipher
        .encrypt(&nonce, data.as_slice())
        .map_err(|_| PkgError::Invalid("加密失败".into()))?;
    out.write_all(&ENC_MAGIC)?;
    out.write_all(&salt)?;
    out.write_all(nonce.as_slice())?;
    out.write_all(&ct)?;
    Ok(())
}

/// ONETVENC1 加密流 → 明文字节流。魔数或 GCM tag 校验失败报 BadPassphrase。
pub fn decrypt_stream(mut input: impl Read, mut out: impl Write, passphrase: &str) -> Result<(), PkgError> {
    let mut magic = [0u8; ENC_MAGIC.len()];
    input.read_exact(&mut magic).map_err(|_| PkgError::BadPassphrase)?;
    if magic != ENC_MAGIC {
        return Err(PkgError::BadPassphrase);
    }
    let mut salt = [0u8; SALT_LEN];
    input.read_exact(&mut salt).map_err(|_| PkgError::BadPassphrase)?;
    let mut nonce = [0u8; NONCE_LEN];
    input.read_exact(&mut nonce).map_err(|_| PkgError::BadPassphrase)?;
    let mut ct = Vec::new();
    input.read_to_end(&mut ct)?;
    let cipher = Aes256Gcm::new((&derive_key(passphrase, &salt)).into());
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| PkgError::BadPassphrase)?;
    out.write_all(&pt)?;
    Ok(())
}

fn passphrase_valid(passphrase: Option<&str>) -> Option<&str> {
    passphrase.filter(|p| !p.is_empty())
}

pub fn export_project(root: &Path, dest_zip: &Path, passphrase: Option<&str>) -> Result<PathBuf, PkgError> {
    // 所见即所得：dest 以 .zip 结尾则原样落盘（不重复追加后缀）；
    // 未带 .zip 则补一次后缀，最终落盘路径以返回值为准。
    let dest = if dest_zip
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        dest_zip.to_path_buf()
    } else {
        let mut s = dest_zip.as_os_str().to_os_string();
        s.push(".zip");
        PathBuf::from(s)
    };
    // 导出前 WAL checkpoint，保证 database.sqlite 自包含
    if let Ok(conn) = onetv_project::db::open(&root.join("database.sqlite")) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    match passphrase_valid(passphrase) {
        // 加密导出：zip 先流式落临时文件，再整流加密到 dest（两遍 IO、恒定内存，zip 阶段不占大内存）
        Some(pass) => {
            let tmp = dest.with_extension("zip.enc.tmp");
            let res = write_zip(root, &tmp)
                .and_then(|()| {
                    encrypt_stream(
                        std::fs::File::open(&tmp)?,
                        std::fs::File::create(&dest)?,
                        pass,
                    )
                });
            let _ = std::fs::remove_file(&tmp);
            res?;
            tracing::info!(dest = %dest.display(), "project exported (encrypted)");
        }
        // 明文导出：与历史行为完全一致（裸 zip）
        None => write_zip(root, &dest)?,
    }
    Ok(dest)
}

fn write_zip(root: &Path, dest: &Path) -> Result<(), PkgError> {
    let file = std::fs::File::create(dest)?;
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
    tracing::info!(files = total, dest = %dest.display(), "project zip written");
    Ok(())
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
/// 自动探测：文件前 8 字节为 ONETVENC1 魔数则按加密包解密（需密码），否则按裸 zip。
pub fn import_project(zip_path: &Path, parent: &Path, passphrase: Option<&str>) -> Result<PathBuf, PkgError> {
    if is_encrypted_file(zip_path) {
        let Some(pass) = passphrase_valid(passphrase) else {
            return Err(PkgError::PassphraseRequired);
        };
        // 解密到临时明文 zip 再走常规解包，避免大内存整包驻留
        let tmp = std::env::temp_dir().join(format!("onetv-pkg-{}.zip", uuid::Uuid::new_v4().simple()));
        let res = decrypt_stream(std::fs::File::open(zip_path)?, std::fs::File::create(&tmp)?, pass)
            .and_then(|()| unzip_into(&tmp, parent));
        let _ = std::fs::remove_file(&tmp);
        res
    } else {
        unzip_into(zip_path, parent)
    }
}

fn unzip_into(zip_path: &Path, parent: &Path) -> Result<PathBuf, PkgError> {
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
    // 防 zip 路径穿越 + 解压体积上限（zip bomb 防护，v2.12.0）
    const MAX_UNCOMPRESSED: u64 = 2 * 1024 * 1024 * 1024; // 2GB
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let name = archive.by_index(i)?.name().to_string();
        if name.contains("..") {
            return Err(PkgError::Invalid("工程包包含可疑路径（..）".into()));
        }
        total = total.saturating_add(archive.by_index(i)?.size());
        if total > MAX_UNCOMPRESSED {
            return Err(PkgError::Invalid("工程包解压体积超过 2GB 上限".into()));
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
        export_project(h.root(), &out_zip, None).unwrap();
        assert!(out_zip.exists());

        let dest_parent = tempfile::tempdir().unwrap();
        let restored = import_project(&out_zip, dest_parent.path(), None).unwrap();
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
    fn export_dest_suffix_wysiwyg() {
        let ws = tempfile::tempdir().unwrap();
        let (h, mut m) = ops::create_project(ws.path(), "后缀测试", "9:16").unwrap();
        let _ep = ops::add_episode(h.root(), &mut m, None).unwrap();

        // 带 .zip 结尾：落盘路径 === 传入路径，不重复追加后缀
        let dest = ws.path().join("A.ytv.zip");
        let out = export_project(h.root(), &dest, None).unwrap();
        assert_eq!(out, dest);
        assert!(dest.exists());

        // 不带 .zip：补一次后缀并返回最终路径
        let dest2 = ws.path().join("B.ytv");
        let out2 = export_project(h.root(), &dest2, None).unwrap();
        assert_eq!(out2, ws.path().join("B.ytv.zip"));
        assert!(out2.exists());
        assert!(!dest2.exists());
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
        assert!(import_project(&zip_path, dest.path(), None).is_err());
    }

    /* ---------------- ONETVENC1 加密工程包 ---------------- */

    /// 真实 roundtrip：临时目录建假工程（含 project.json）→ 加密导出 →
    /// 错误密码失败 → 正确密码导入成功且 project.json 内容一致。
    #[test]
    fn encrypted_export_import_roundtrip() {
        let ws = tempfile::tempdir().unwrap();
        let (h, mut m) = ops::create_project(ws.path(), "加密测试", "9:16").unwrap();
        let _ep = ops::add_episode(h.root(), &mut m, None).unwrap();
        let project_json = std::fs::read_to_string(h.root().join("project.json")).unwrap();

        let out_zip = ws.path().join("enc.ytv.zip");
        let out = export_project(h.root(), &out_zip, Some("密码123")).unwrap();
        assert_eq!(out, out_zip);
        // 落盘即 ONETVENC1 容器
        let mut head = [0u8; ENC_MAGIC.len()];
        std::fs::File::open(&out).unwrap().read_exact(&mut head).unwrap();
        assert_eq!(head, ENC_MAGIC);
        assert!(is_encrypted_file(&out));

        // 错误密码：导入失败，报「密码错误或文件已损坏」
        let dest_parent = tempfile::tempdir().unwrap();
        let err = import_project(&out, dest_parent.path(), Some("wrong")).unwrap_err();
        assert!(err.to_string().contains("密码错误或文件已损坏"), "{err}");

        // 无密码：报「需要密码」
        let err2 = import_project(&out, dest_parent.path(), None).unwrap_err();
        assert!(matches!(err2, PkgError::PassphraseRequired));

        // 正确密码：导入成功且 project.json 内容一致
        let restored = import_project(&out, dest_parent.path(), Some("密码123")).unwrap();
        assert!(restored.join("project.json").exists());
        assert_eq!(std::fs::read_to_string(restored.join("project.json")).unwrap(), project_json);
        let (_, m2) = ops::open_project(&restored).unwrap();
        assert_eq!(m2.project.title, "加密测试");
    }

    /// 裸 zip 兼容：无密码导出的包不带魔数，导入行为与历史一致。
    #[test]
    fn plain_zip_still_imports_without_passphrase() {
        let ws = tempfile::tempdir().unwrap();
        let (h, mut m) = ops::create_project(ws.path(), "明文包", "16:9").unwrap();
        let _ep = ops::add_episode(h.root(), &mut m, None).unwrap();
        let out_zip = ws.path().join("plain.ytv.zip");
        export_project(h.root(), &out_zip, None).unwrap();
        assert!(!is_encrypted_file(&out_zip));

        let dest_parent = tempfile::tempdir().unwrap();
        let restored = import_project(&out_zip, dest_parent.path(), None).unwrap();
        assert!(restored.join("project.json").exists());
        // 裸包即使误传密码也按明文走（自动探测以魔数为准）
        let restored2 = import_project(&out_zip, dest_parent.path(), Some("whatever")).unwrap();
        assert!(restored2.join("project.json").exists());
    }

    /// 魔数校验：缺魔数/魔数损坏的输入解密必败。
    #[test]
    fn decrypt_rejects_bad_magic() {
        let ws = tempfile::tempdir().unwrap();
        let src = ws.path().join("x.bin");
        let dst = ws.path().join("y.bin");
        std::fs::write(&src, b"not an encrypted container at all").unwrap();

        // 裸 zip 字节流直接解密 → BadPassphrase
        let mut out = Vec::new();
        let err = decrypt_stream(std::fs::File::open(&src).unwrap(), &mut out, "pw").unwrap_err();
        assert!(matches!(err, PkgError::BadPassphrase), "{err}");

        // 魔数损坏（ONETVENC1 → ONETVENCX）→ BadPassphrase
        let mut corrupted = Vec::new();
        corrupted.extend_from_slice(b"ONETVENCX");
        corrupted.extend_from_slice(&[0u8; 40]);
        std::fs::write(&dst, &corrupted).unwrap();
        let err2 = decrypt_stream(std::fs::File::open(&dst).unwrap(), &mut out, "pw").unwrap_err();
        assert!(matches!(err2, PkgError::BadPassphrase));
    }

    /// 篡改检测：密文任一字节被改动 → GCM tag 校验失败。
    #[test]
    fn decrypt_rejects_tampered_ciphertext() {
        let ws = tempfile::tempdir().unwrap();
        let src = ws.path().join("enc.bin");
        encrypt_stream("hello onetv 加密内容".as_bytes(), std::fs::File::create(&src).unwrap(), "pw").unwrap();
        let mut bytes = std::fs::read(&src).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        std::fs::write(&src, &bytes).unwrap();

        let mut out = Vec::new();
        let err = decrypt_stream(std::fs::File::open(&src).unwrap(), &mut out, "pw").unwrap_err();
        assert!(matches!(err, PkgError::BadPassphrase), "{err}");
    }

    /// 纯函数 roundtrip：encrypt_stream → decrypt_stream 还原原文；错误密码失败。
    #[test]
    fn encrypt_decrypt_stream_roundtrip() {
        let plaintext = b"zip-bytes-\xf0\x9f\x8e\xac-0123456789";
        let mut enc = Vec::new();
        encrypt_stream(plaintext.as_slice(), &mut enc, "s3cret").unwrap();
        assert!(enc.starts_with(&ENC_MAGIC));
        assert_ne!(&enc[ENC_MAGIC.len()..], &plaintext[..]);

        let mut dec = Vec::new();
        decrypt_stream(enc.as_slice(), &mut dec, "s3cret").unwrap();
        assert_eq!(dec, plaintext);

        let mut dec2 = Vec::new();
        assert!(decrypt_stream(enc.as_slice(), &mut dec2, "nope").is_err());
    }
}
