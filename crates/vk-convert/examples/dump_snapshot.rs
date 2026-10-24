//! 调试用：把样例文件转换成 Univer 快照 JSON 并打印。
//! 用法: cargo run -p vk-convert --example dump_snapshot -- <file> [ext]

use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let file = args.next().expect("用法: dump_snapshot <file> [ext]");
    let ext = args.next().unwrap_or_else(|| {
        Path::new(&file)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let bytes = std::fs::read(&file).expect("读取文件失败");
    match vk_convert::convert(&bytes, &ext, &file) {
        Ok(snap) => {
            println!("{}", serde_json::to_string(&snap).unwrap());
        }
        Err(e) => {
            eprintln!("convert error: {e}");
            std::process::exit(1);
        }
    }
}
