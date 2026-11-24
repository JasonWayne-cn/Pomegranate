//! 识别后术语纠错。
//!
//! 借鉴 cc-haha 的 `services/voice/correction`：LLM 的输出**不直接采信**，
//! 而是与原始识别文本做 token 级 diff，只采纳"命中术语词表"的替换，
//! 其余差异（标点抖动、润色、改写）一律丢弃。这样即使模型越权改写，
//! 也污染不了用户的口述内容。
//!
//! 流程：
//!   1. 未启用 / 词表为空 → 原样返回，不调用模型
//!   2. 构造固定 prompt → `AiService::complete_once`
//!   3. 相似度门槛（LCS 比例 < 0.6 或长度差 > 60% → 整体放弃）
//!   4. token diff → 逐块判定是否属于词表内替换
//!
//! 纠错失败（无默认模型、网络错误）不阻断录入：返回原文并记日志。

use crate::database::Database;
use crate::error::AppError;
use crate::models::{AsrConfig, AsrTextChange, AsrVocabularyTerm};
use crate::services::ai::AiService;

/// 参与纠错的词表上限（超出只取前 N 条，避免 prompt 过长）
const MAX_VOCAB: usize = 100;
/// 原文长度上限（字符）；超过直接跳过纠错
const MAX_TEXT_CHARS: usize = 2000;
/// token 数上限（LCS 是 O(n*m)，超过保护性放弃）
const MAX_TOKENS: usize = 4000;
/// LCS 相似度下限
const MIN_SIMILARITY: f32 = 0.6;
/// 长度比上限
const MAX_LENGTH_RATIO: f32 = 1.6;

pub async fn correct(
    db: &Database,
    cfg: &AsrConfig,
    raw: &str,
) -> Result<(String, Vec<AsrTextChange>), AppError> {
    let raw = raw.trim();
    if !cfg.correction_enabled || raw.is_empty() || raw.chars().count() > MAX_TEXT_CHARS {
        return Ok((raw.to_string(), Vec::new()));
    }

    let vocab = db.list_asr_vocabulary()?;
    if vocab.is_empty() {
        return Ok((raw.to_string(), Vec::new()));
    }

    let prompt = build_prompt(raw, &vocab);
    let candidate = match AiService::complete_once(db, &prompt, None).await {
        Ok(text) => text,
        Err(e) => {
            log::warn!("语音纠错调用失败，保留原文: {e}");
            return Ok((raw.to_string(), Vec::new()));
        }
    };

    Ok(filter_correction(raw, &candidate, &vocab))
}

/// 构造纠错 prompt：只修词表术语，禁止任何其他改动。
pub fn build_prompt(raw: &str, vocab: &[AsrVocabularyTerm]) -> String {
    let mut table = String::new();
    for entry in vocab.iter().take(MAX_VOCAB) {
        table.push_str("- ");
        table.push_str(&entry.term);
        if !entry.aliases.is_empty() {
            table.push_str(" ← ");
            table.push_str(&entry.aliases.join("、"));
        }
        table.push('\n');
    }

    format!(
        "你是语音识别结果的术语纠正器。只修正下面「常用词表」中列出的术语——\
把被听错、音近或写法不规范的用法改成标准写法。其他任何内容（错别字、语序、语气、标点、\
翻译、润色）一律保持原样。不要添加、删除或解释任何内容。\
只输出纠正后的完整文本，不要输出前缀、引号或代码块。\n\n\
常用词表（标准写法 ← 常被听成）：\n{table}\n\
待纠正文本：\n{raw}"
    )
}

/// 对 LLM 输出做安全过滤，只保留词表内的术语替换。
///
/// 返回 `(纠正后文本, 被采纳的替换列表)`。任何不确定的情况都回退原文。
pub fn filter_correction(
    raw: &str,
    candidate: &str,
    vocab: &[AsrVocabularyTerm],
) -> (String, Vec<AsrTextChange>) {
    let unchanged = || (raw.trim().to_string(), Vec::new());

    let cand = strip_code_fence(candidate.trim());
    if cand.is_empty() || cand == raw.trim() {
        return unchanged();
    }

    let a = tokenize(raw);
    let b = tokenize(&cand);
    if a.is_empty() || b.is_empty() || a.len() > MAX_TOKENS || b.len() > MAX_TOKENS {
        return unchanged();
    }

    // 长度比：模型把短句扩写成段落时直接拒绝
    let (la, lb) = (a.len() as f32, b.len() as f32);
    if la.max(lb) / la.min(lb).max(1.0) > MAX_LENGTH_RATIO {
        return unchanged();
    }

    let pairs = lcs_pairs(&a, &b);
    if (pairs.len() as f32) / la.max(lb) < MIN_SIMILARITY {
        return unchanged();
    }

    let mut out = String::new();
    let mut changes = Vec::new();
    let (mut prev_a, mut prev_b) = (0usize, 0usize);

    for (i, j) in pairs.into_iter().chain(std::iter::once((a.len(), b.len()))) {
        if i > prev_a || j > prev_b {
            let seg_a = join_tokens(&a[prev_a..i]);
            let seg_b = join_tokens(&b[prev_b..j]);
            if is_vocab_replacement(&seg_a, &seg_b, vocab) {
                out.push_str(&seg_b);
                let from = seg_a.trim();
                let to = seg_b.trim();
                if !from.is_empty() && from != to {
                    changes.push(AsrTextChange {
                        from: from.to_string(),
                        to: to.to_string(),
                    });
                }
            } else {
                out.push_str(&seg_a);
            }
        }
        if i < a.len() {
            out.push_str(&a[i]);
        }
        prev_a = i + 1;
        prev_b = j + 1;
    }

    if changes.is_empty() {
        return unchanged();
    }
    (out, changes)
}

/// 差异块是否属于"同一词条内"的术语替换（含别名 → 规范写法）。
fn is_vocab_replacement(a: &str, b: &str, vocab: &[AsrVocabularyTerm]) -> bool {
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() || b.is_empty() || a.eq_ignore_ascii_case(b) {
        return false;
    }
    vocab.iter().any(|entry| {
        let hits_a = eq_term(&entry.term, a) || entry.aliases.iter().any(|x| eq_term(x, a));
        let hits_b = eq_term(&entry.term, b) || entry.aliases.iter().any(|x| eq_term(x, b));
        hits_a && hits_b
    })
}

fn eq_term(x: &str, y: &str) -> bool {
    x.trim().eq_ignore_ascii_case(y.trim())
}

fn strip_code_fence(s: &str) -> String {
    let s = s.trim();
    if s.starts_with("```") {
        let inner = s.trim_start_matches("```");
        // 去掉可能的语言标记行
        let inner = inner.split_once('\n').map(|(_, rest)| rest).unwrap_or(inner);
        return inner.trim_end_matches("```").trim().to_string();
    }
    s.to_string()
}

// ─── token 化与 LCS ────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    Space,
    Cjk,
    Punct,
}

fn classify(ch: char) -> Kind {
    if ch.is_whitespace() {
        Kind::Space
    } else if is_cjk(ch) {
        Kind::Cjk
    } else if ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.' | '+') {
        Kind::Word
    } else {
        Kind::Punct
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x3040..=0x30FF)
}

/// 切分 token：中文逐字，英文/标识符按连续串，空白与标点各自成块。
fn tokenize(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut kind: Option<Kind> = None;

    for ch in s.chars() {
        let k = classify(ch);
        if k == Kind::Cjk {
            // 中文逐字成 token，避免整句被当成一个不可分的块
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            out.push(ch.to_string());
            kind = None;
            continue;
        }
        if kind == Some(k) {
            buf.push(ch);
        } else {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            buf.push(ch);
            kind = Some(k);
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn join_tokens(tokens: &[String]) -> String {
    let mut s = String::new();
    for t in tokens {
        s.push_str(t);
    }
    s
}

/// 标准 LCS 回溯，返回匹配下标对（保证从前往后、单调递增）。
fn lcs_pairs(a: &[String], b: &[String]) -> Vec<(usize, usize)> {
    let (m, n) = (a.len(), b.len());
    let mut dp = vec![0u32; (m + 1) * (n + 1)];
    let idx = |i: usize, j: usize| i * (n + 1) + j;

    for i in (0..m).rev() {
        for j in (0..n).rev() {
            dp[idx(i, j)] = if a[i] == b[j] {
                dp[idx(i + 1, j + 1)] + 1
            } else {
                dp[idx(i + 1, j)].max(dp[idx(i, j + 1)])
            };
        }
    }

    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < m && j < n {
        if a[i] == b[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if dp[idx(i + 1, j)] >= dp[idx(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab(term: &str, aliases: &[&str]) -> Vec<AsrVocabularyTerm> {
        vec![AsrVocabularyTerm {
            id: 1,
            term: term.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            created_at: "2026-11-24 00:00:00".into(),
        }]
    }

    #[test]
    fn accepts_alias_to_term() {
        let v = vocab("Tauri", &["涛瑞", "陶瑞"]);
        let (out, changes) = filter_correction("我用涛瑞写桌面应用", "我用Tauri写桌面应用", &v);
        assert_eq!(out, "我用Tauri写桌面应用");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from, "涛瑞");
        assert_eq!(changes[0].to, "Tauri");
    }

    #[test]
    fn rejects_unrelated_rewrite() {
        let v = vocab("Tauri", &["涛瑞"]);
        // 模型润色了句子，即使错字也不该采纳
        let (out, changes) = filter_correction(
            "这个功能真的非常好用",
            "这个功能确实十分好用",
            &v,
        );
        assert_eq!(out, "这个功能真的非常好用");
        assert!(changes.is_empty());
    }

    #[test]
    fn rejects_punctuation_drift() {
        let v = vocab("Tauri", &["涛瑞"]);
        let (out, changes) = filter_correction("我用涛瑞。", "我用Tauri。", &v);
        assert_eq!(out, "我用Tauri。");
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn rejects_when_low_similarity() {
        let v = vocab("Tauri", &["涛瑞"]);
        let (out, changes) = filter_correction("涛瑞", "完全无关的另外一段很长的话", &v);
        assert_eq!(out, "涛瑞");
        assert!(changes.is_empty());
    }

    #[test]
    fn rejects_insertion_only() {
        let v = vocab("Tauri", &["涛瑞"]);
        // 纯插入（模型加了词）不该被当成替换
        let (out, changes) = filter_correction("我写代码", "我在写Tauri代码", &v);
        assert_eq!(out, "我写代码");
        assert!(changes.is_empty());
    }

    #[test]
    fn code_fence_is_stripped() {
        let v = vocab("Tauri", &["涛瑞"]);
        let (out, changes) = filter_correction(
            "用涛瑞开发",
            "```\n用Tauri开发\n```",
            &v,
        );
        assert_eq!(out, "用Tauri开发");
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn identical_candidate_is_noop() {
        let v = vocab("Tauri", &["涛瑞"]);
        let (out, changes) = filter_correction("用 Tauri 开发", "用 Tauri 开发", &v);
        assert_eq!(out, "用 Tauri 开发");
        assert!(changes.is_empty());
    }

    #[test]
    fn prompt_contains_terms() {
        let v = vocab("Tauri", &["涛瑞", "陶瑞"]);
        let p = build_prompt("用涛瑞开发", &v);
        assert!(p.contains("Tauri ← 涛瑞、陶瑞"));
        assert!(p.contains("用涛瑞开发"));
    }
}
