//! 后台维护任务（janitor）：回收站过期清理、版本裁剪、孤儿对象 GC、审计日志保留。
//!
//! 这些都是 `VIENTO_TRASH_RETENTION_DAYS` / `VIENTO_VERSION_KEEP` /
//! `VIENTO_AUDIT_RETENTION_DAYS` 在文档里承诺过、但此前没有任何代码执行的策略：
//! 没有它，回收站、历史版本、审计表只增不减，删除文件也永远不释放磁盘。
//!
//! 间隔由 `VIENTO_JANITOR_INTERVAL_MINUTES` 控制（默认 360 分钟，0 = 关闭），
//! 服务启动后立即跑第一轮，之后按间隔循环。每一轮的删除条数都会记日志。
//!
//! 安全边界：
//! - 孤儿对象 GC 只删「任何 `file_versions` 都不引用」且**落盘超过 24 小时**的 blob，
//!   避免误删正在上传（已 rename 但 DB 行还没写入）的新对象；
//! - 版本裁剪永远保留最新 `version_keep` 个版本（当前版本一定是最新的）；
//! - 目录清理按 `deleted_at` 过期，只动回收站里的行。

use std::collections::HashSet;
use std::time::Duration;

use vk_store::StoreError;
use vk_store::repo::audit::Audit;

use crate::AppState;

/// 孤儿对象最短存活时长：新上传的对象在 DB 行落库前有一个短暂窗口。
const GC_MIN_AGE_HOURS: i64 = 24;

/// 启动后台维护任务（非阻塞）。
pub fn spawn(state: AppState) {
    let minutes = state.cfg.janitor_interval_minutes;
    if minutes == 0 {
        tracing::info!("后台维护任务已关闭（VIENTO_JANITOR_INTERVAL_MINUTES=0）");
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(minutes.saturating_mul(60)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match run_once(&state).await {
                Ok(report) if report.any() => tracing::info!(
                    trashed_files = report.trashed_files,
                    trashed_dirs = report.trashed_dirs,
                    pruned_versions = report.pruned_versions,
                    gc_objects = report.gc_objects,
                    gc_tmp = report.gc_tmp,
                    pruned_audits = report.pruned_audits,
                    "后台维护完成"
                ),
                Ok(_) => tracing::debug!("后台维护完成（无需要清理的数据）"),
                Err(e) => tracing::warn!(error = %e, "后台维护失败（下轮重试）"),
            }
        }
    });
}

#[derive(Default, Debug)]
pub struct Report {
    pub trashed_files: u64,
    pub trashed_dirs: u64,
    pub pruned_versions: u64,
    pub gc_objects: u64,
    pub gc_tmp: u64,
    pub pruned_audits: u64,
}

impl Report {
    fn any(&self) -> bool {
        self.trashed_files > 0
            || self.trashed_dirs > 0
            || self.pruned_versions > 0
            || self.gc_objects > 0
            || self.gc_tmp > 0
            || self.pruned_audits > 0
    }
}

pub async fn run_once(state: &AppState) -> Result<Report, StoreError> {
    let pool = state.db.pool();
    let mut report = Report::default();

    // 1) 回收站过期清理（文件先删，目录再删；目录删除会级联其下文件）
    if state.cfg.trash_retention_days > 0 {
        let days = state.cfg.trash_retention_days as i64;
        report.trashed_files = sqlx::query(
            "DELETE FROM files
             WHERE deleted_at IS NOT NULL
               AND deleted_at < now() - make_interval(days => $1::int)",
        )
        .bind(days)
        .execute(pool)
        .await
        .map_err(StoreError::Sqlx)?
        .rows_affected();
        report.trashed_dirs = sqlx::query(
            "DELETE FROM directories
             WHERE deleted_at IS NOT NULL
               AND deleted_at < now() - make_interval(days => $1::int)",
        )
        .bind(days)
        .execute(pool)
        .await
        .map_err(StoreError::Sqlx)?
        .rows_affected();
    }

    // 2) 版本裁剪：每文件只保留最新 version_keep 个
    if state.cfg.version_keep > 0 {
        let keep = state.cfg.version_keep as i64;
        report.pruned_versions = sqlx::query(
            "DELETE FROM file_versions v
             WHERE v.id IN (
                 SELECT id FROM (
                     SELECT id, row_number() OVER (PARTITION BY file_id ORDER BY version DESC) AS rn
                     FROM file_versions
                 ) ranked
                 WHERE ranked.rn > $1
             )",
        )
        .bind(keep)
        .execute(pool)
        .await
        .map_err(StoreError::Sqlx)?
        .rows_affected();
    }

    // 3) 孤儿对象 GC：任何版本都不引用、且落盘超过 24h 的 blob
    let referenced: HashSet<String> =
        sqlx::query_scalar("SELECT DISTINCT sha256 FROM file_versions")
            .fetch_all(pool)
            .await
            .map_err(StoreError::Sqlx)?
            .into_iter()
            .collect();
    let all = state
        .objects
        .list_all()
        .await
        .map_err(|e| StoreError::Internal(e.to_string()))?;
    let cutoff =
        std::time::SystemTime::now() - Duration::from_secs((GC_MIN_AGE_HOURS as u64) * 3600);
    for sha in all {
        if referenced.contains(&sha) {
            continue;
        }
        let path = state.objects.path_for(&sha);
        let old = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old && state.objects.remove(&sha).await.is_ok() {
            report.gc_objects += 1;
        }
    }
    // 3b) 清理中断的上传临时文件（`.upload-*`，同样只清 24h 前的）
    report.gc_tmp = cleanup_stale_uploads(state).await;

    // 4) 审计日志保留
    if state.cfg.audit_retention_days > 0 {
        let days = state.cfg.audit_retention_days as i64;
        report.pruned_audits =
            sqlx::query("DELETE FROM audit_logs WHERE ts < now() - make_interval(days => $1::int)")
                .bind(days)
                .execute(pool)
                .await
                .map_err(StoreError::Sqlx)?
                .rows_affected();
    }

    let _ = Audit::log(
        pool,
        None,
        "admin",
        "janitor_run",
        None,
        None,
        serde_json::json!({
            "trashedFiles": report.trashed_files,
            "trashedDirs": report.trashed_dirs,
            "prunedVersions": report.pruned_versions,
            "gcObjects": report.gc_objects,
            "gcTmp": report.gc_tmp,
            "prunedAudits": report.pruned_audits,
        }),
        None,
    )
    .await;

    Ok(report)
}

async fn cleanup_stale_uploads(state: &AppState) -> u64 {
    // 对象目录布局为 `{root}/objects/{prefix}/...`；临时文件直接落在 `{root}/objects/`。
    // ObjectStore 没暴露目录，借 path_for("") 的父目录反推。
    let objects_root = state
        .objects
        .path_for("ab")
        .parent()
        .map(|p| p.parent().map(|q| q.to_path_buf()));
    let Some(Some(dir)) = objects_root else {
        return 0;
    };
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return 0;
    };
    let cutoff =
        std::time::SystemTime::now() - Duration::from_secs((GC_MIN_AGE_HOURS as u64) * 3600);
    let mut removed = 0u64;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".upload-") {
            continue;
        }
        let old = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old && tokio::fs::remove_file(entry.path()).await.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 单元测试：只验证报告汇总逻辑（DB/FS 行为由 e2e 覆盖）。
#[cfg(test)]
mod tests {
    use super::Report;

    #[test]
    fn report_any_flag() {
        let mut r = Report::default();
        assert!(!r.any());
        r.gc_objects = 1;
        assert!(r.any());
    }
}
