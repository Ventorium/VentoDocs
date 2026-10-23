//! CSPRNG 随机 ID 生成（分享 token / 发布标识）。
//!
//! 分享 token：256-bit 随机，base62 编码（52 字符），不可猜测。
//! 发布标识：16 位随机小写字母+数字（去除易混淆的 0/o/1/i/l），每目录持久。

use rand::Rng;

const TOKEN_LEN: usize = 52; // 256 bit 的 base62 表示
const PUBLISH_LEN: usize = 16;

const TOKEN_ALPHABET: &[u8; 62] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PUBLISH_ALPHABET: &[u8; 31] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// 生成 256-bit 分享 token（base62，52 字符）。
pub fn gen_share_token() -> String {
    let mut rng = rand::thread_rng();
    let mut out = String::with_capacity(TOKEN_LEN);
    for _ in 0..TOKEN_LEN {
        out.push(TOKEN_ALPHABET[rng.gen_range(0..62)] as char);
    }
    out
}

/// 生成 16 位发布标识（字符集去除 0/o/1/i/l，避免视觉混淆）。
pub fn gen_publish_id() -> String {
    let mut rng = rand::thread_rng();
    let mut out = String::with_capacity(PUBLISH_LEN);
    for _ in 0..PUBLISH_LEN {
        out.push(PUBLISH_ALPHABET[rng.gen_range(0..31)] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_length_and_charset() {
        let t = gen_share_token();
        assert_eq!(t.len(), TOKEN_LEN);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn publish_id_length_and_no_ambiguous_chars() {
        let p = gen_publish_id();
        assert_eq!(p.len(), PUBLISH_LEN);
        assert!(
            p.chars()
                .all(|c| "abcdefghjkmnpqrstuvwxyz23456789".contains(c))
        );
    }

    #[test]
    fn tokens_are_unique() {
        let a = gen_share_token();
        let b = gen_share_token();
        assert_ne!(a, b);
        let p1 = gen_publish_id();
        let p2 = gen_publish_id();
        assert_ne!(p1, p2);
    }
}
