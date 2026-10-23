//! 本地对象存储：内容寻址（sha256）落盘。
//!
//! 目录结构：`{root}/objects/{前2位}/{sha256 剩余 62 位}`。
//! 上传流式写入临时文件并计算 sha256，完成后原子 rename 到目标路径；
//! 同名对象已存在时直接复用（去重）。

use std::path::{Path, PathBuf};

use anyhow::Result;
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;

/// 一次上传/保存产生的对象引用。
#[derive(Debug, Clone)]
pub struct UploadResult {
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn object_dir(&self) -> PathBuf {
        self.root.join("objects")
    }

    pub fn path_for(&self, sha256: &str) -> PathBuf {
        let prefix = &sha256[..2.min(sha256.len())];
        self.object_dir()
            .join(prefix)
            .join(sha256.get(2..).unwrap_or(""))
    }

    pub async fn ensure_dirs(&self) -> Result<()> {
        tokio::fs::create_dir_all(self.object_dir()).await?;
        Ok(())
    }

    /// 流式读取输入到临时文件，边读边算 sha256；超过 max_bytes 立即失败并清理。
    pub async fn ingest<R>(&self, mut reader: R, max_bytes: u64) -> Result<UploadResult>
    where
        R: AsyncRead + Unpin,
    {
        let dir = self.object_dir();
        tokio::fs::create_dir_all(&dir).await?;
        let tmp = dir.join(format!(".upload-{}", uuid::Uuid::new_v4()));

        let mut hash = Sha256::new();
        let mut size: u64 = 0;
        let mut buf = vec![0u8; CHUNK];
        {
            let mut file = File::create(&tmp).await?;
            loop {
                let n = reader.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                if size + n as u64 > max_bytes {
                    file.flush().await?;
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp).await;
                    anyhow::bail!("文件大小超过上限 {max_bytes} 字节");
                }
                size += n as u64;
                hash.update(&buf[..n]);
                file.write_all(&buf[..n]).await?;
            }
            file.flush().await?;
        }

        let sha = format!("{:x}", hash.finalize());
        let dest = self.path_for(&sha);
        if Path::new(&dest).exists() {
            let _ = tokio::fs::remove_file(&tmp).await;
        } else if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
            tokio::fs::rename(&tmp, &dest).await?;
        }

        Ok(UploadResult { sha256: sha, size })
    }

    pub async fn open(&self, sha256: &str) -> Result<File> {
        let p = self.path_for(sha256);
        File::open(&p)
            .await
            .map_err(|e| anyhow::anyhow!("对象不存在：{sha256}（{e}）"))
    }

    pub async fn size_of(&self, sha256: &str) -> Option<u64> {
        tokio::fs::metadata(self.path_for(sha256))
            .await
            .ok()
            .map(|m| m.len())
    }

    pub fn has(&self, sha256: &str) -> bool {
        self.path_for(sha256).exists()
    }

    /// 删除单个对象文件（GC 时按引用计数确认后调用）。
    pub async fn remove(&self, sha256: &str) -> Result<()> {
        match tokio::fs::remove_file(self.path_for(sha256)).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// 列出磁盘上全部对象 sha（GC 比对用）。
    pub async fn list_all(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        let base = self.object_dir();
        let mut prefix_dirs = tokio::fs::read_dir(&base).await?;
        while let Some(entry) = prefix_dirs.next_entry().await? {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let prefix = entry.file_name().to_string_lossy().into_owned();
            let mut inner = tokio::fs::read_dir(&p).await?;
            while let Some(e2) = inner.next_entry().await? {
                if e2.path().is_file()
                    && let Some(name) = e2.file_name().to_str()
                {
                    out.push(format!("{prefix}{name}"));
                }
            }
        }
        Ok(out)
    }
}
