-- M2.2：文件版本存储编码。
-- office  = 原始上传的 Office/CSV 字节（calamine/docx-rs 解析）
-- univer  = 在线编辑保存的 Univer 快照 JSON（导出时服务端实时转回 Office）
ALTER TABLE file_versions
    ADD COLUMN encoding TEXT NOT NULL DEFAULT 'office'
    CHECK (encoding IN ('office', 'univer'));
