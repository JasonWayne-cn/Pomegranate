//! 笔记正文哈希工具
//!
//! 用于导入去重：对笔记内容算 SHA-256（16 进制字符串），存到 notes.content_hash 字段，
//! 扫描外部 md 文件时以 (title, content_hash) 做兜底匹配。
//! 不用于安全场景——只要"碰撞概率足够低"即可。
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

pub fn sha256_hex(content: &str) -> String {
    sha256_hex_bytes(content.as_bytes())
}

/// 对任意字节算 SHA-256（16 进制）。
pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

/// 流式计算文件 SHA-256，避免把大 PDF / Word / Excel 一次性读进内存。
pub fn sha256_file_hex(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    Ok(s)
}
