-- M2.28：站点模式（static 纯静态 | spa Vite try_files | file_index 文件列表）。
ALTER TABLE published_dirs ADD COLUMN site_mode text NOT NULL DEFAULT 'static';
