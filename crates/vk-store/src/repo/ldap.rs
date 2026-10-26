//! LDAP 目录导入：ldap3 直连查询，单向同步到本地 users（§15）。
//!
//! 单向语义（§15）：
//! - 已存在（按用户名）→ 更新显示名/邮箱/DN，不创建、不改密码、不启用；
//! - 新条目 → `Users::create_ldap`（本地不可登录，需管理员另设密码）；
//! - LDAP 侧删除不联动本地用户。
//!
//! 在线配置（§15 扩展）：配置存于 `ldap_config` 单行表，bind 密码用
//! AES-256-GCM 加密（密钥 = SHA-256(VIENTO_JWT_SECRET)）；数据库无行时回退环境变量。

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use ldap3::LdapConnAsync;
use ldap3::{LdapConnSettings, SearchEntry, Scope};
use sha2::{Digest, Sha256};

use super::users::Users;
use crate::Db;

/// LDAP 连接配置（全部来自环境变量，§15/§16）。
#[derive(Clone, Debug, serde::Serialize)]
pub struct LdapConfig {
    /// LDAP 主机（如 `ldap.example.com` 或 `ldap://ldap.example.com:389`）。
    pub host: String,
    /// 端口（ldap 389 / ldaps 636）。
    pub port: u16,
    /// 是否使用 StartTLS（636 端口默认 LDAPS）。
    pub start_tls: bool,
    /// 搜索基础 DN。
    pub base_dn: String,
    /// 只读绑定账号 DN；为空则匿名绑定。
    pub bind_dn: String,
    #[serde(skip)]
    pub bind_password: String,
    /// 用户过滤器，如 `(objectClass=inetOrgPerson)`。
    pub user_filter: String,
    /// 字段映射：username / 姓名 / 邮箱。
    pub attr_username: String,
    pub attr_name: String,
    pub attr_email: String,
}

/// 单个 LDAP 条目的映射结果。
#[derive(Debug, Clone)]
pub struct LdapEntry {
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub dn: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LdapImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub failed: Vec<String>,
}

impl LdapConfig {
    /// 从环境变量读取；`VIENTO_LDAP_HOST` 未设置表示功能未配置。
    pub fn from_env() -> Option<Self> {
        let host_raw = env_str("VIENTO_LDAP_HOST")?;
        let stripped = host_raw
            .strip_prefix("ldap://")
            .or_else(|| host_raw.strip_prefix("ldaps://"))
            .unwrap_or(&host_raw);
        let is_ldaps = host_raw.starts_with("ldaps://");
        let (host, port_env) = match stripped.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (stripped, None),
        };
        let default_port = env_str("VIENTO_LDAP_PORT")
            .and_then(|p| p.parse().ok())
            .unwrap_or(if is_ldaps { 636 } else { 389 });
        let port = port_env.and_then(|p| p.parse().ok()).unwrap_or(default_port);
        Some(Self {
            host: host.to_string(),
            port,
            start_tls: env_flag("VIENTO_LDAP_START_TLS"),
            base_dn: env_str("VIENTO_LDAP_BASE_DN").unwrap_or_default(),
            bind_dn: env_str("VIENTO_LDAP_BIND_DN").unwrap_or_default(),
            bind_password: env_str("VIENTO_LDAP_BIND_PASSWORD").unwrap_or_default(),
            user_filter: env_str("VIENTO_LDAP_USER_FILTER")
                .unwrap_or_else(|| "(objectClass=inetOrgPerson)".to_string()),
            attr_username: env_str("VIENTO_LDAP_ATTR_USERNAME").unwrap_or_else(|| "uid".into()),
            attr_name: env_str("VIENTO_LDAP_ATTR_NAME").unwrap_or_else(|| "cn".into()),
            attr_email: env_str("VIENTO_LDAP_ATTR_EMAIL").unwrap_or_else(|| "mail".into()),
        })
    }

    /// 供 UI 展示的连接摘要（不含密码）。
    pub fn public_info(&self) -> serde_json::Value {
        serde_json::json!({
            "host": self.host,
            "port": self.port,
            "startTls": self.start_tls,
            "baseDn": self.base_dn,
            "bindDn": self.bind_dn,
            "userFilter": self.user_filter,
            "attrUsername": self.attr_username,
            "attrName": self.attr_name,
            "attrEmail": self.attr_email,
        })
    }

    fn url(&self) -> String {
        let scheme = if self.port == 636 && !self.start_tls {
            "ldaps"
        } else {
            "ldap"
        };
        format!("{scheme}://{}:{}", self.host, self.port)
    }
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_flag(key: &str) -> bool {
    env_str(key)
        .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

/// 连接 LDAP 并执行用户过滤器搜索，返回映射后的条目（不做数据库写入）。
pub async fn search_users(cfg: &LdapConfig) -> Result<Vec<LdapEntry>, String> {
    let url = cfg.url();
    let settings = LdapConnSettings::new().set_starttls(cfg.start_tls);
    let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &url)
        .await
        .map_err(|e| format!("连接 LDAP {url} 失败: {e}"))?;
    ldap3::drive!(conn);

    if !cfg.bind_dn.is_empty() {
        ldap.simple_bind(&cfg.bind_dn, &cfg.bind_password)
            .await
            .map_err(|e| format!("LDAP 绑定失败（检查绑定账号/密码）: {e}"))?;
    }

    let attrs = [
        cfg.attr_username.as_str(),
        cfg.attr_name.as_str(),
        cfg.attr_email.as_str(),
    ];
    let search_res = ldap
        .search(&cfg.base_dn, Scope::Subtree, &cfg.user_filter, attrs.as_ref())
        .await
        .map_err(|e| format!("LDAP 搜索失败: {e}"))?;

    let entries = match search_res.success() {
        Ok((entries, _info)) => entries,
        Err(e) => return Err(format!("LDAP 搜索失败: {e}")),
    };

    let mut out = Vec::new();
    for re in entries {
        let e = SearchEntry::construct(re);
        let username = e
            .attrs
            .get(&cfg.attr_username.to_lowercase())
            .and_then(|v| v.first().cloned())
            .unwrap_or_default();
        if username.trim().is_empty() {
            continue;
        }
        let display = e
            .attrs
            .get(&cfg.attr_name.to_lowercase())
            .and_then(|v| v.first().cloned())
            .filter(|v| !v.trim().is_empty());
        let email = e
            .attrs
            .get(&cfg.attr_email.to_lowercase())
            .and_then(|v| v.first().cloned())
            .filter(|v| !v.trim().is_empty());
        out.push(LdapEntry {
            username: username.trim().to_string(),
            display_name: display,
            email,
            dn: e.dn,
        });
    }
    out.sort_by(|a, b| a.username.cmp(&b.username));
    Ok(out)
}

/// 搜索 LDAP 并将条目单向同步到本地 users。
pub async fn import_to_db(db: &Db, cfg: &LdapConfig) -> Result<LdapImportResult, String> {
    let pool = db.pool();
    let entries = search_users(cfg).await?;
    let mut res = LdapImportResult {
        imported: 0,
        skipped: 0,
        failed: vec![],
    };
    for e in entries {
        match Users::get_by_username(pool, &e.username).await {
            Err(err) => res.failed.push(format!("{}: {err}", e.username)),
            // 已存在：跳过计数，仅同步元数据（display_name / email / ldap_dn），
            // 永不触碰 password / role / disabled（§15）
            Ok(Some(existing)) => {
                match Users::update_ldap_meta(
                    pool,
                    existing.id,
                    e.display_name.as_deref(),
                    e.email.as_deref(),
                    Some(&e.dn),
                )
                .await
                {
                    Ok(()) => res.skipped += 1,
                    Err(err) => res.failed.push(format!("{}: {err}", e.username)),
                }
            }
            Ok(None) => match Users::create_ldap(
                pool,
                &e.username,
                e.display_name.as_deref().unwrap_or(&e.username),
                e.email.as_deref(),
                Some(&e.dn),
            )
            .await
            {
                Ok(_) => res.imported += 1,
                Err(err) => res.failed.push(format!("{}: {err}", e.username)),
            },
        }
    }
    Ok(res)
}

// ==================== 在线配置（§15 扩展）：DB 单行 + AES-256-GCM 凭据加密 ====================

/// 从共享密钥派生 256-bit 加密密钥（SHA-256）。
pub fn derive_key(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

/// AES-256-GCM 加密明文，返回 hex(12 字节随机 nonce ‖ 密文‖tag)。
pub fn encrypt_secret(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce_bytes: [u8; 12] = rand::random();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|e| format!("LDAP 密码加密失败: {e}"))?;
    let mut buf = Vec::with_capacity(12 + ct.len());
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ct);
    Ok(hex::encode(buf))
}

/// 解密 `encrypt_secret` 的产物；密钥不匹配或数据损坏返回 Err。
pub fn decrypt_secret(key: &[u8; 32], hex_ciphertext: &str) -> Result<String, String> {
    let buf = hex::decode(hex_ciphertext).map_err(|e| format!("密文格式非法: {e}"))?;
    if buf.len() < 28 {
        return Err("密文长度不足".to_string());
    }
    let (nonce_bytes, ct) = buf.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "LDAP 密码解密失败（密钥不匹配或数据损坏）".to_string())?;
    String::from_utf8(pt).map_err(|_| "密文不是有效 UTF-8".to_string())
}

/// `ldap_config` 表原始行（bind_password 为密文，未解密）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LdapConfigRow {
    pub host: String,
    pub port: i32,
    pub start_tls: bool,
    pub base_dn: String,
    pub bind_dn: String,
    /// AES-256-GCM 密文 hex；None 表示未设置密码。
    pub bind_password: Option<String>,
    pub user_filter: String,
    pub attr_username: String,
    pub attr_name: String,
    pub attr_email: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

const LDAP_CONFIG_COLS: &str = "host, port, start_tls, base_dn, bind_dn, bind_password, user_filter, attr_username, attr_name, attr_email, updated_at";

/// 读取配置行；表内无行返回 Ok(None)（调用方应回退环境变量）。
pub async fn load_ldap_config_row(pool: &sqlx::PgPool) -> Result<Option<LdapConfigRow>, String> {
    type Row = (
        String,
        i32,
        bool,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
    );
    let row: Option<Row> = sqlx::query_as(&format!("SELECT {LDAP_CONFIG_COLS} FROM ldap_config WHERE id = 1"))
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取 ldap_config 失败: {e}"))?;
    Ok(row.map(
        |r| LdapConfigRow {
            host: r.0,
            port: r.1,
            start_tls: r.2,
            base_dn: r.3,
            bind_dn: r.4,
            bind_password: r.5,
            user_filter: r.6,
            attr_username: r.7,
            attr_name: r.8,
            attr_email: r.9,
            updated_at: r.10,
        },
    ))
}

/// 写入配置行（upsert，id 恒为 1）。`bind_password_hex` 为加密后的密文，None = 不存密码。
pub async fn save_ldap_config(
    pool: &sqlx::PgPool,
    cfg: &LdapConfig,
    bind_password_hex: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO ldap_config (id, host, port, start_tls, base_dn, bind_dn, bind_password, user_filter, attr_username, attr_name, attr_email, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (id) DO UPDATE SET
            host = EXCLUDED.host,
            port = EXCLUDED.port,
            start_tls = EXCLUDED.start_tls,
            base_dn = EXCLUDED.base_dn,
            bind_dn = EXCLUDED.bind_dn,
            bind_password = EXCLUDED.bind_password,
            user_filter = EXCLUDED.user_filter,
            attr_username = EXCLUDED.attr_username,
            attr_name = EXCLUDED.attr_name,
            attr_email = EXCLUDED.attr_email,
            updated_at = now()",
    )
    .bind(&cfg.host)
    .bind(cfg.port as i32)
    .bind(cfg.start_tls)
    .bind(&cfg.base_dn)
    .bind(&cfg.bind_dn)
    .bind(bind_password_hex)
    .bind(&cfg.user_filter)
    .bind(&cfg.attr_username)
    .bind(&cfg.attr_name)
    .bind(&cfg.attr_email)
    .execute(pool)
    .await
    .map_err(|e| format!("写入 ldap_config 失败: {e}"))?;
    Ok(())
}

/// 删除配置行（恢复回退到环境变量）。
pub async fn delete_ldap_config(pool: &sqlx::PgPool) -> Result<bool, String> {
    let res = sqlx::query("DELETE FROM ldap_config WHERE id = 1")
        .execute(pool)
        .await
        .map_err(|e| format!("删除 ldap_config 失败: {e}"))?;
    Ok(res.rows_affected() > 0)
}

/// 配置来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LdapConfigSource {
    /// 来自数据库（在线配置）。
    Database,
    /// 来自环境变量 VIENTO_LDAP_*。
    Env,
}

/// 解析生效配置：DB 行优先（解密密码），无行则回退环境变量；
/// 都没有返回 Ok(None)。返回 (配置, 来源, 是否设置了 bind 密码)。
pub async fn resolve_ldap_config(
    pool: &sqlx::PgPool,
    key: &[u8; 32],
) -> Result<Option<(LdapConfig, LdapConfigSource, bool)>, String> {
    if let Some(row) = load_ldap_config_row(pool).await? {
        let password = match &row.bind_password {
            Some(hex_ct) => decrypt_secret(key, hex_ct)?,
            None => String::new(),
        };
        let cfg = LdapConfig {
            host: row.host,
            port: row.port as u16,
            start_tls: row.start_tls,
            base_dn: row.base_dn,
            bind_dn: row.bind_dn,
            bind_password: password,
            user_filter: row.user_filter,
            attr_username: row.attr_username,
            attr_name: row.attr_name,
            attr_email: row.attr_email,
        };
        return Ok(Some((cfg, LdapConfigSource::Database, row.bind_password.is_some())));
    }
    match LdapConfig::from_env() {
        Some(c) => {
            let password_set = !c.bind_password.is_empty();
            Ok(Some((c, LdapConfigSource::Env, password_set)))
        }
        None => Ok(None),
    }
}
