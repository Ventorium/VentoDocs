//! LDAP 目录导入：ldap3 直连查询，单向同步到本地 users（§15）。
//!
//! 单向语义（§15）：
//! - 已存在（按用户名）→ 更新显示名/邮箱/DN，不创建、不改密码、不启用；
//! - 新条目 → `Users::create_ldap`（本地不可登录，需管理员另设密码）；
//! - LDAP 侧删除不联动本地用户。

use ldap3::LdapConnAsync;
use ldap3::{LdapConnSettings, SearchEntry, Scope};

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
