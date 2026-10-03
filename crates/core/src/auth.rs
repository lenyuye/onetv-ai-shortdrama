//! 本地账户（v2.1）：登录门 + 凭据管理 + 邮箱找回。
//!
//! - 默认账户 admin / 12345（首次启动自动初始化）；
//! - 修改用户名/密码必须已绑定邮箱（或在同一次调用中同时绑定邮箱）；
//! - 忘记密码：验证绑定邮箱地址即可重置（本地应用，无验证码下发能力，如实实现）；
//! - 密码只存加盐迭代哈希（SHA-256 × 12000，salt 16B 随机），绝不存明文；
//! - 本模块完全本地，无任何网络行为。

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};

const DEFAULT_USERNAME: &str = "admin";
const DEFAULT_PASSWORD: &str = "12345";
const ITERATIONS: u32 = 12_000;
/// 登录会话保持：5 天内无使用才要求重新登录（v2.3）
const SESSION_TTL_SECS: u64 = 5 * 24 * 60 * 60;

/// 测试时钟偏移（秒）：时间边界测试钩子（0 = 真实系统时间）。
/// 设置途径：① 环境变量 ONETV_TEST_TIME_OFFSET_SEC（启动时）；② 调试命令
/// debug_set_time_offset / 设置页连点版本号 5 次唤出。仅影响会话过期判断等
/// now_secs() 消费点，不修改系统时钟。
static TIME_OFFSET_SECS: AtomicI64 = AtomicI64::new(0);

pub fn set_time_offset(secs: i64) {
    TIME_OFFSET_SECS.store(secs, Ordering::Relaxed);
    tracing::warn!(seconds = secs, "test time offset changed (time-boundary test hook)");
}

pub fn time_offset() -> i64 {
    TIME_OFFSET_SECS.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccountFile {
    schema_version: String,
    username: String,
    #[serde(default)]
    email: Option<String>,
    salt: String,
    password_hash: String,
}

/// 本机会话（session.json）：仅含随机 token 与用户名，绝不含密码/哈希。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionFile {
    token: String,
    username: String,
    created_at: u64,
    last_used: u64,
}

pub struct AuthStore {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountInfo {
    pub username: String,
    pub email: Option<String>,
    pub has_default_password: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("{0}")]
    Invalid(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化: {0}")]
    Serde(#[from] serde_json::Error),
}

impl AuthStore {
    pub fn new(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self { path: dir.join("auth.json") }
    }

    fn load(&self) -> Option<AccountFile> {
        let raw = std::fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn save(&self, a: &AccountFile) -> Result<(), AuthError> {
        let json = serde_json::to_string_pretty(a)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// 首次启动初始化默认账户 admin/12345。
    pub fn ensure_initialized(&self) -> Result<(), AuthError> {
        if self.load().is_some() {
            return Ok(());
        }
        let salt = new_salt();
        let account = AccountFile {
            schema_version: "1.0".into(),
            username: DEFAULT_USERNAME.into(),
            email: None,
            salt: hex::encode(&salt),
            password_hash: hash_password(DEFAULT_PASSWORD, &salt),
        };
        self.save(&account)?;
        // 不记录默认密码明文，只保留账户名级别的信息
        tracing::info!("default account initialized (admin) — user must change it");
        Ok(())
    }

    pub fn info(&self) -> Option<AccountInfo> {
        let a = self.load()?;
        Some(AccountInfo {
            username: a.username.clone(),
            email: a.email.clone(),
            has_default_password: verify_against(DEFAULT_PASSWORD, &a.salt, &a.password_hash),
        })
    }

    pub fn verify_login(&self, username: &str, password: &str) -> Result<bool, AuthError> {
        let Some(a) = self.load() else {
            return Err(AuthError::Invalid("账户未初始化".into()));
        };
        if username.trim().to_lowercase() != a.username.to_lowercase() {
            return Ok(false);
        }
        Ok(verify_against(password, &a.salt, &a.password_hash))
    }

    /// 绑定/更换邮箱（需要当前密码验证）。
    pub fn bind_email(&self, current_password: &str, email: &str) -> Result<(), AuthError> {
        let mut a = self.load().ok_or_else(|| AuthError::Invalid("账户未初始化".into()))?;
        if !verify_against(current_password, &a.salt, &a.password_hash) {
            return Err(AuthError::Invalid("当前密码不正确".into()));
        }
        let email = normalize_email(email)?;
        a.email = Some(email);
        self.save(&a)
    }

    /// 修改用户名/密码。规则：必须已绑定邮箱；若未绑定，必须在本调用中同时提供 email。
    #[allow(clippy::too_many_arguments)]
    pub fn change_credentials(
        &self,
        current_password: &str,
        new_username: Option<&str>,
        new_password: Option<&str>,
        email: Option<&str>,
    ) -> Result<AccountInfo, AuthError> {
        let mut a = self.load().ok_or_else(|| AuthError::Invalid("账户未初始化".into()))?;
        if !verify_against(current_password, &a.salt, &a.password_hash) {
            return Err(AuthError::Invalid("当前密码不正确".into()));
        }
        // 邮箱：绑定或校验必须存在
        match (email, &a.email) {
            (Some(e), _) => {
                a.email = Some(normalize_email(e)?);
            }
            (None, None) => {
                return Err(AuthError::Invalid(
                    "修改用户名/密码必须先绑定邮箱：请在下方填写并提交绑定邮箱".into(),
                ));
            }
            (None, Some(_)) => {}
        }
        if let Some(u) = new_username {
            let u = u.trim();
            if u.len() < 3 || u.len() > 32 {
                return Err(AuthError::Invalid("用户名长度需在 3~32 个字符".into()));
            }
            if !u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || !c.is_ascii()) {
                return Err(AuthError::Invalid("用户名含非法字符".into()));
            }
            a.username = u.to_string();
        }
        if let Some(p) = new_password {
            if p.len() < 5 {
                return Err(AuthError::Invalid("新密码至少 5 位".into()));
            }
            if p == DEFAULT_PASSWORD {
                return Err(AuthError::Invalid("不能继续使用默认密码 12345".into()));
            }
            let salt = new_salt();
            a.salt = hex::encode(&salt);
            a.password_hash = hash_password(p, &salt);
        }
        self.save(&a)?;
        // 凭据已变更：作废所有旧会话，需重新登录
        self.clear_session();
        Ok(AccountInfo {
            username: a.username,
            email: a.email,
            has_default_password: false,
        })
    }

    /// 忘记密码：验证绑定邮箱即可重置（规格：本地应用仅验证邮箱地址）。
    /// 尚未修改过默认账户（仍是 admin/12345）时不可重置 —— 引导用户直接登录。
    pub fn reset_with_email(&self, email: &str, new_password: &str) -> Result<(), AuthError> {
        let mut a = self.load().ok_or_else(|| AuthError::Invalid("账户未初始化".into()))?;
        if verify_against(DEFAULT_PASSWORD, &a.salt, &a.password_hash) {
            return Err(AuthError::Invalid(
                "你还未设置账号和密码，请按默认方式登录（admin / 12345）".into(),
            ));
        }
        let Some(bound) = &a.email else {
            return Err(AuthError::Invalid("该账户尚未绑定邮箱，无法通过邮箱重置".into()));
        };
        if normalize_email(email)? != *bound {
            return Err(AuthError::Invalid("邮箱与绑定邮箱不一致".into()));
        }
        if new_password.len() < 5 {
            return Err(AuthError::Invalid("新密码至少 5 位".into()));
        }
        let salt = new_salt();
        a.salt = hex::encode(&salt);
        a.password_hash = hash_password(new_password, &salt);
        self.save(&a)?;
        // 凭据已变更：作废所有旧会话
        self.clear_session();
        Ok(())
    }

    /* ---------------- 登录会话保持（v2.3） ---------------- */

    fn session_path(&self) -> PathBuf {
        self.path.with_file_name("session.json")
    }

    /// 登录成功后写入会话，供下次启动免登录。
    pub fn create_session(&self, username: &str) -> Result<(), AuthError> {
        let now = now_secs();
        let mut token = [0u8; 32];
        let _ = std::fs::File::open("/dev/urandom")
            .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut token));
        let s = SessionFile {
            token: hex::encode(token),
            username: username.to_string(),
            created_at: now,
            last_used: now,
        };
        let tmp = self.session_path().with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(&s)?)?;
        std::fs::rename(&tmp, self.session_path())?;
        Ok(())
    }

    /// 会话是否仍然有效（5 天内有过使用）。有效则顺延 last_used；过期/损坏则清除。
    pub fn refresh_session(&self) -> bool {
        let p = self.session_path();
        let Ok(raw) = std::fs::read_to_string(&p) else { return false };
        let Ok(mut s) = serde_json::from_str::<SessionFile>(&raw) else {
            let _ = std::fs::remove_file(&p);
            return false;
        };
        let now = now_secs();
        if now.saturating_sub(s.last_used) > SESSION_TTL_SECS {
            let _ = std::fs::remove_file(&p);
            return false;
        }
        s.last_used = now;
        let _ = std::fs::write(&p, serde_json::to_string(&s).unwrap_or_default());
        true
    }

    /// 主动登出 / 凭据变更时清除会话。
    pub fn clear_session(&self) {
        let _ = std::fs::remove_file(self.session_path());
    }

    /// 会话剩余有效秒数（不刷新 last_used）。None = 无会话；0 或负 = 已过期。
    /// 供时间边界测试钩子读取核对。
    pub fn session_remaining_secs(&self) -> Option<i64> {
        let raw = std::fs::read_to_string(self.session_path()).ok()?;
        let s: SessionFile = serde_json::from_str(&raw).ok()?;
        let elapsed = now_secs().saturating_sub(s.last_used) as i64;
        Some(SESSION_TTL_SECS as i64 - elapsed)
    }
}

fn now_secs() -> u64 {
    let base = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let off = time_offset();
    if off >= 0 {
        base.saturating_add(off as u64)
    } else {
        base.saturating_sub(off.unsigned_abs())
    }
}

fn new_salt() -> [u8; 16] {
    // 从 OS 随机源取熵；无 std 直接依赖时回退时间+进程熵
    let mut buf = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_err()
    {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut h = sha2::Sha256::new();
        h.update(seed.to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        buf.copy_from_slice(&h.finalize()[..16]);
    }
    buf
}

fn hash_password(password: &str, salt: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(salt);
    h.update(password.as_bytes());
    let mut cur = h.finalize();
    for _ in 1..ITERATIONS {
        let mut h = sha2::Sha256::new();
        h.update(&cur);
        cur = h.finalize();
    }
    hex::encode(cur)
}

fn verify_against(password: &str, salt_hex: &str, hash_hex: &str) -> bool {
    let Ok(salt) = hex::decode(salt_hex) else { return false };
    constant_eq(&hash_password(password, &salt), hash_hex)
}

fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn normalize_email(email: &str) -> Result<String, AuthError> {
    let e = email.trim().to_lowercase();
    let ok = {
        let parts: Vec<&str> = e.split('@').collect();
        parts.len() == 2
            && !parts[0].is_empty()
            && parts[0].len() <= 64
            && parts[1].contains('.')
            && !parts[1].starts_with('.')
            && !parts[1].ends_with('.')
            && parts[1].split('.').all(|s| !s.is_empty())
            && e.len() <= 254
            && e.chars().all(|c| c.is_ascii() && !c.is_whitespace())
    };
    if ok {
        Ok(e)
    } else {
        Err(AuthError::Invalid("邮箱地址格式不正确".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_account_and_login() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::new(dir.path());
        store.ensure_initialized().unwrap();
        assert!(store.verify_login("admin", "12345").unwrap());
        assert!(!store.verify_login("admin", "wrong").unwrap());
        assert!(!store.verify_login("root", "12345").unwrap());
        let info = store.info().unwrap();
        assert_eq!(info.username, "admin");
        assert_eq!(info.email, None);
        assert!(info.has_default_password);
        // 文件中不存在明文密码
        let raw = std::fs::read_to_string(dir.path().join("auth.json")).unwrap();
        assert!(!raw.contains("12345"));
    }

    #[test]
    fn change_requires_email_bound() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::new(dir.path());
        store.ensure_initialized().unwrap();

        // 未绑邮箱 → 拒绝
        let e1 = store.change_credentials("12345", Some("boss"), Some("newpass"), None).unwrap_err();
        assert!(e1.to_string().contains("绑定邮箱"));

        // 同调用绑定邮箱 + 改名改密 → 成功
        let info = store
            .change_credentials("12345", Some("boss"), Some("newpass"), Some("Me@Example.COM "))
            .unwrap();
        assert_eq!(info.username, "boss");
        assert_eq!(info.email.as_deref(), Some("me@example.com"));
        assert!(store.verify_login("boss", "newpass").unwrap());

        // 已绑邮箱后再改 → 只需当前密码
        store.change_credentials("newpass", Some("chief"), None, None).unwrap();
        assert!(store.verify_login("chief", "newpass").unwrap());
    }

    #[test]
    fn email_reset_flow() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::new(dir.path());
        store.ensure_initialized().unwrap();
        store
            .change_credentials("12345", None, Some("secret1"), Some("a@b.cn"))
            .unwrap();

        // 邮箱不匹配 → 拒绝
        assert!(store.reset_with_email("wrong@b.cn", "secret2").is_err());
        // 邮箱匹配 → 重置成功
        store.reset_with_email("A@B.CN", "secret2").unwrap();
        assert!(store.verify_login("admin", "secret2").unwrap());
        assert!(!store.verify_login("admin", "secret1").unwrap());
    }

    #[test]
    fn email_validation() {
        assert!(normalize_email("a@b.cn").is_ok());
        assert!(normalize_email("a@@b.cn").is_err());
        assert!(normalize_email("a@b").is_err());
        assert!(normalize_email("@b.cn").is_err());
        assert!(normalize_email("a b@b.cn").is_err());
    }

    #[test]
    fn session_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::new(dir.path());
        store.ensure_initialized().unwrap();

        // 未登录：无会话
        assert!(!store.refresh_session());

        // 登录 → 会话有效
        store.create_session("admin").unwrap();
        assert!(store.refresh_session());

        // 篡改过期（模拟 5 天未使用）→ 失效且文件被清除
        let p = dir.path().join("session.json");
        let mut s: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        s["last_used"] = serde_json::json!(0u64);
        std::fs::write(&p, serde_json::to_string(&s).unwrap()).unwrap();
        assert!(!store.refresh_session());
        assert!(!p.exists());

        // 登出清除
        store.create_session("admin").unwrap();
        store.clear_session();
        assert!(!store.refresh_session());

        // 改密后旧会话作废
        store.create_session("admin").unwrap();
        store
            .change_credentials("12345", None, Some("newpass1"), Some("a@b.cn"))
            .unwrap();
        assert!(!store.refresh_session());
    }

    /// 时间边界测试钩子（SESSION-005~008 解除阻塞）：
    /// 4天23:59:59 → 有效；5天整 → 有效（"5 天内"）；5天+1秒 → 过期清除。
    #[test]
    fn session_time_boundary_with_test_clock() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::new(dir.path());
        store.ensure_initialized().unwrap();
        store.create_session("admin").unwrap();
        let p = dir.path().join("session.json");

        // 4 天 23:59:59：仍有效（refresh 成功会顺延 last_used，故先断言剩余时长）
        set_time_offset(5 * 86_400 - 1);
        assert_eq!(store.session_remaining_secs(), Some(1));
        assert!(store.refresh_session());

        // 5 天整：仍有效（"5 天内"含第 5 天最后一刻，now - last_used == TTL 不超限）
        set_time_offset(0);
        store.create_session("admin").unwrap();
        set_time_offset(5 * 86_400);
        assert_eq!(store.session_remaining_secs(), Some(0));
        assert!(store.refresh_session());

        // 5 天 + 1 秒：过期，会话文件清除（会话须建立在真实时间点，再推进 TTL+1）
        set_time_offset(0);
        store.create_session("admin").unwrap();
        set_time_offset(5 * 86_400 + 1);
        assert!(!store.refresh_session());
        assert!(!p.exists());

        // 负偏移（回到过去）与会话共存：不 panic、视为有效
        store.create_session("admin").unwrap();
        set_time_offset(-3_600);
        assert!(store.refresh_session());

        // 恢复真实时钟（全局状态，务必复位，避免影响其他测试）
        set_time_offset(0);
        assert!(store.refresh_session());
    }
}
