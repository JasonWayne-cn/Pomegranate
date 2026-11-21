//! HTML ↔ Markdown 转换共享工具
//!
//! 原来 import.rs / export.rs 各自有一份私有实现，迁移到此作为单一来源。
//! 未来 HTML → Markdown 存储迁移、编辑器 MD I/O、".md 文件打开"等功能
//! 都基于这里的两个函数。
//!
//! - `html_to_markdown`：Tiptap 产出的 HTML → Markdown（使用 `html2md` crate）
//! - `markdown_to_html`：Markdown → Tiptap 可吃的 HTML（使用 `pulldown-cmark`）

use pulldown_cmark::{html, Options, Parser};
use serde::Deserialize;

/// 从 markdown 文本头部解析 YAML frontmatter
///
/// 形如
/// ```text
/// ---
/// title: My Note
/// tags:
///   - foo
///   - bar
/// ---
/// 正文
/// ```
/// 或
/// ```text
/// ---
/// tags: [foo, bar]
/// ---
/// 正文
/// ```
///
/// 返回 `(parsed, body_without_frontmatter)`。如果文本不以 `---\n` 开头、或没有
/// 闭合的 `---`、或 yaml 解析失败，则返回 `(None, original_text)` —— 永远不丢内容。
///
/// 主要用于 T-009 OB 整库导入：把 frontmatter 中的 `tags` 解析出来后剥离正文，
/// 让导入的文档内容保持纯净。
pub fn parse_frontmatter(text: &str) -> (Option<FrontMatter>, String) {
    // 必须以 ---\n（或 ---\r\n） 开头
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"));
    let Some(rest) = rest else {
        return (None, text.to_string());
    };

    // 找闭合的 \n---\n 或 \n---\r\n 或文末 \n---
    let (yaml_str, body) = match find_frontmatter_end(rest) {
        Some((y, b)) => (y, b),
        None => return (None, text.to_string()),
    };

    match serde_yml::from_str::<FrontMatter>(yaml_str) {
        Ok(fm) => (Some(fm), body.to_string()),
        Err(_) => (None, text.to_string()),
    }
}

/// 在 `rest`（去掉首个 `---\n` 后的剩余文本）中找闭合的 `---` 行
/// 返回 (yaml_inner, body_after)
fn find_frontmatter_end(rest: &str) -> Option<(&str, &str)> {
    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            let yaml_str = &rest[..idx];
            let body_after = &rest[idx + line.len()..];
            return Some((yaml_str, body_after));
        }
        idx += line.len();
    }
    // 文末没换行的 ---
    let trimmed = rest.trim_end();
    if trimmed.ends_with("---") || trimmed.ends_with("...") {
        let line_start = rest.rfind('\n').map(|p| p + 1).unwrap_or(0);
        let yaml_str = &rest[..line_start];
        return Some((yaml_str, ""));
    }
    None
}

/// 更新 / 插入 YAML frontmatter 的 `tags` 字段，返回新的完整文本。
///
/// 设计取舍：
/// - **不重新序列化整个 YAML**：只替换顶层 `tags:` 行（含块状列表），其余字段与注释原样保留。
/// - 原文没有 frontmatter 时在文件头新建一段 `---\ntags: [...]\n---`。
/// - 保持原文件的换行风格（LF / CRLF）。
/// - 标签名统一用双引号包裹并转义，避免 `:` / `#` / `[` 等字符破坏 YAML。
///
/// 这样挂载目录里的 `.md` 文件被 UI 打了标签后，可以把标签写回源文件；
/// 下次扫描重新解析 frontmatter 时标签不会丢失。
pub fn set_frontmatter_tags(text: &str, tags: &[String]) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let tags_line = format!(
        "tags: [{}]",
        tags.iter()
            .map(|t| yaml_double_quote(t.trim()))
            .filter(|t| t != "\"\"")
            .collect::<Vec<_>>()
            .join(", ")
    );

    let Some((yaml, body)) = split_frontmatter(text) else {
        let mut out = String::with_capacity(text.len() + tags_line.len() + 16);
        out.push_str("---");
        out.push_str(nl);
        out.push_str(&tags_line);
        out.push_str(nl);
        out.push_str("---");
        out.push_str(nl);
        if !text.is_empty() {
            out.push_str(nl);
            out.push_str(text);
        }
        return out;
    };

    let new_yaml = replace_yaml_tags(yaml, &tags_line, nl);
    let mut out = String::with_capacity(new_yaml.len() + body.len() + 16);
    out.push_str("---");
    out.push_str(nl);
    out.push_str(&new_yaml);
    out.push_str("---");
    out.push_str(nl);
    out.push_str(body);
    out
}

/// 拆出 frontmatter 的 YAML 内容与正文（不含 opener / closer）。
/// 与 [`parse_frontmatter`] 不同，这里不做 YAML 解析，仅做文本定位，保证能写回。
fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let opener_len = if text.starts_with("---\r\n") {
        5
    } else if text.starts_with("---\n") {
        4
    } else {
        return None;
    };
    let rest = &text[opener_len..];
    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            return Some((&rest[..idx], &rest[idx + line.len()..]));
        }
        idx += line.len();
    }
    None
}

/// 在 YAML 文本中替换顶层 `tags:`；不存在则追加到末尾。
fn replace_yaml_tags(yaml: &str, tags_line: &str, nl: &str) -> String {
    let mut lines: Vec<String> = yaml.split_inclusive('\n').map(|s| s.to_string()).collect();
    let mut found = false;

    let mut i = 0;
    while i < lines.len() {
        let no_nl = lines[i].trim_end_matches(['\n', '\r']);
        let trimmed = no_nl.trim_start();
        let indent = no_nl.len() - trimmed.len();
        if indent == 0 && trimmed.starts_with("tags:") {
            // 块状列表：吞掉紧随其后的缩进 `- item` 行
            let mut end = i + 1;
            while end < lines.len() {
                let l = lines[end].trim_end_matches(['\n', '\r']);
                if l.is_empty() {
                    break;
                }
                let t = l.trim_start();
                let ind = l.len() - t.len();
                if ind > 0 && (t == "-" || t.starts_with("- ")) {
                    end += 1;
                } else {
                    break;
                }
            }
            lines.splice(i..end, std::iter::once(format!("{tags_line}{nl}")));
            found = true;
            break;
        }
        i += 1;
    }

    if !found {
        if let Some(last) = lines.last_mut() {
            if !last.ends_with('\n') {
                last.push_str(nl);
            }
        }
        lines.push(format!("{tags_line}{nl}"));
    }

    lines.concat()
}

/// YAML 双引号转义（总是加引号，避免特殊字符歧义）
fn yaml_double_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// OB 风格 frontmatter 关心的子集
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrontMatter {
    /// `tags: [a, b]` 或 `tags:\n  - a\n  - b` 都接受
    #[serde(default, deserialize_with = "deserialize_string_or_seq")]
    pub tags: Vec<String>,
    /// OB `aliases:` — 当前不入库，预留 T-009b 用作"别名搜索"
    #[allow(dead_code)]
    #[serde(default, deserialize_with = "deserialize_string_or_seq")]
    pub aliases: Vec<String>,
    /// 用户写的标题（覆盖正文 `# H1` 兜底）
    #[serde(default)]
    pub title: Option<String>,
}

/// 兼容 yaml 写成单字符串 / 字符串数组 / 用空字符串占位 三种情况
fn deserialize_string_or_seq<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    use std::fmt;

    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("string or seq of strings")
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
            if s.is_empty() {
                Ok(vec![])
            } else {
                // OB 也支持 `tags: foo, bar` 这种内联，自然分割逗号
                Ok(s.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect())
            }
        }
        fn visit_string<E: de::Error>(self, s: String) -> Result<Self::Value, E> {
            self.visit_str(&s)
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(v) = seq.next_element::<serde_yml::Value>()? {
                if let Some(s) = v.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        out.push(t.to_string());
                    }
                }
            }
            Ok(out)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(vec![])
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(vec![])
        }
    }
    d.deserialize_any(V)
}

/// HTML → Markdown
///
/// 空串/仅空白直接返回空串，避免 html2md 在边界情况下的异常。
///
/// 注意：`html2md` 对 `<h1>` / `<h2>` 用 setext 风格（`===` / `---` 下划线），
/// 其它级别用 ATX 风格（`### ...`）。不影响渲染，但与其它工具互通时需注意。
pub fn html_to_markdown(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    html2md::parse_html(html)
}

/// 判断整篇 Markdown 是否可以安全启用 `ENABLE_MATH`。
///
/// pulldown-cmark 的 `$...$` 配对比编辑器迁移逻辑宽松：`价格$100元，原价$200元`
/// 会被误当成公式，两个 `$` 会从正文里消失。这里沿用编辑器 `inlineMathRanges`
/// 的保守规则——只要存在「收尾 `$` 紧跟数字」的候选对，就整篇禁用数学解析。
pub fn math_is_safe(markdown: &str) -> bool {
    if !markdown.contains('$') {
        return true;
    }
    // 注：Rust regex 不支持 lookahead，这里先匹配 `$…$` 再手工检查紧随其后的字符。
    let Ok(re) = regex::Regex::new(r"\$[^$\n]+?\$") else {
        // 正则异常时宁可关闭数学解析，也不要吞掉正文。
        return false;
    };
    for m in re.find_iter(markdown) {
        if markdown[m.end()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
        {
            return false;
        }
    }
    true
}

/// Markdown → HTML（开启 GFM：表格 / 删除线 / 任务列表）
///
/// 修正点：pulldown-cmark 会在 `</code>` 前插入尾部换行符，导致
/// Tiptap CodeBlock 渲染时多出一个空行，这里统一剥除。
///
/// 当前无调用方（Tiptap 已切 MD I/O，编辑器自行渲染），保留给未来的
/// "MD 预览"/"分享 HTML 片段" 等场景。
#[allow(dead_code)]
pub fn markdown_to_html(md: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(md, options);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out.replace("\n</code></pre>", "</code></pre>")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 公式文本可启用数学解析；货币式 `$…$` 必须禁用，避免吞掉正文。
    #[test]
    fn math_safety_allows_formulas_and_rejects_currency() {
        assert!(math_is_safe("行内 $x^2$ 公式"));
        assert!(math_is_safe("$$\n\\int_0^1 x dx\n$$"));
        assert!(!math_is_safe("价格$100元，原价$200元"));
        assert!(!math_is_safe("售价 $100 与 $200 元"));
        assert!(math_is_safe("没有公式的正文"));
    }

    #[test]
    fn md_to_html_basic() {
        let html = markdown_to_html("# 标题\n\n段落文本");
        assert!(html.contains("<h1>"));
        assert!(html.contains("段落文本"));
    }

    #[test]
    fn html_to_md_basic() {
        let md = html_to_markdown("<h1>标题</h1><p>段落文本</p>");
        // html2md 对 h1 用 setext 风格（`=====` 下划线），不硬校验语法
        assert!(md.contains("标题"));
        assert!(md.contains("段落文本"));
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(html_to_markdown(""), "");
        assert_eq!(html_to_markdown("   \n"), "");
    }

    #[test]
    fn roundtrip_preserves_core_structure() {
        let original = "# 标题\n\n- 列表 A\n- 列表 B\n\n**粗体**";
        let html = markdown_to_html(original);
        let back = html_to_markdown(&html);
        assert!(back.contains("标题"));
        assert!(back.contains("列表 A"));
        assert!(back.contains("**粗体**"));
    }

    #[test]
    fn fm_no_frontmatter_returns_original() {
        let (fm, body) = parse_frontmatter("# Hello\n\nbody");
        assert!(fm.is_none());
        assert_eq!(body, "# Hello\n\nbody");
    }

    #[test]
    fn fm_inline_array_tags() {
        let text = "---\ntags: [foo, bar, baz]\n---\n# Hello";
        let (fm, body) = parse_frontmatter(text);
        let fm = fm.expect("应解析到 frontmatter");
        assert_eq!(fm.tags, vec!["foo", "bar", "baz"]);
        assert_eq!(body, "# Hello");
    }

    #[test]
    fn fm_block_list_tags() {
        let text = "---\ntags:\n  - alpha\n  - beta\ntitle: My Note\n---\nbody";
        let (fm, body) = parse_frontmatter(text);
        let fm = fm.expect("应解析到 frontmatter");
        assert_eq!(fm.tags, vec!["alpha", "beta"]);
        assert_eq!(fm.title.as_deref(), Some("My Note"));
        assert_eq!(body, "body");
    }

    #[test]
    fn fm_single_string_tag() {
        let text = "---\ntags: solo\n---\nbody";
        let (_, body) = parse_frontmatter(text);
        let (fm, _) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["solo"]);
        assert_eq!(body, "body");
    }

    #[test]
    fn fm_inline_csv_string() {
        let text = "---\ntags: a, b, c\n---\nbody";
        let (fm, _) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["a", "b", "c"]);
    }

    #[test]
    fn fm_unclosed_returns_original() {
        let text = "---\ntags: [a]\n# 缺少闭合";
        let (fm, body) = parse_frontmatter(text);
        assert!(fm.is_none());
        assert_eq!(body, text);
    }

    #[test]
    fn fm_invalid_yaml_returns_original_with_no_data_loss() {
        let text = "---\nthis is { not: valid }: yaml::\n---\nbody";
        let (fm, body) = parse_frontmatter(text);
        assert!(fm.is_none());
        assert_eq!(body, text); // 内容必须原样保留
    }

    #[test]
    fn fm_empty_tags_field() {
        let text = "---\ntags:\ntitle: T\n---\nbody";
        let (fm, _) = parse_frontmatter(text);
        let fm = fm.unwrap();
        assert!(fm.tags.is_empty());
        assert_eq!(fm.title.as_deref(), Some("T"));
    }

    #[test]
    fn fm_crlf_line_endings() {
        let text = "---\r\ntags: [x]\r\n---\r\nbody";
        let (fm, body) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["x"]);
        assert_eq!(body, "body");
    }

    #[test]
    fn write_tags_existing_inline() {
        let text = "---\ntitle: T\ntags: [old]\n---\nbody";
        let out = set_frontmatter_tags(text, &["新标签".into(), "work".into()]);
        assert_eq!(out, "---\ntitle: T\ntags: [\"新标签\", \"work\"]\n---\nbody");
        let (fm, body) = parse_frontmatter(&out);
        assert_eq!(fm.unwrap().tags, vec!["新标签", "work"]);
        assert_eq!(body, "body");
    }

    #[test]
    fn write_tags_existing_block() {
        let text = "---\ntitle: T\ntags:\n  - old\n  - old2\n---\nbody";
        let out = set_frontmatter_tags(text, &["a".into()]);
        assert_eq!(out, "---\ntitle: T\ntags: [\"a\"]\n---\nbody");
    }

    #[test]
    fn write_tags_insert_when_missing() {
        let text = "---\ntitle: T\n---\nbody";
        let out = set_frontmatter_tags(text, &["a".into()]);
        assert_eq!(out, "---\ntitle: T\ntags: [\"a\"]\n---\nbody");
    }

    #[test]
    fn write_tags_create_frontmatter() {
        let out = set_frontmatter_tags("# Hello\n\nbody", &["a".into(), "b".into()]);
        assert_eq!(out, "---\ntags: [\"a\", \"b\"]\n---\n\n# Hello\n\nbody");
        let (fm, body) = parse_frontmatter(&out);
        assert_eq!(fm.unwrap().tags, vec!["a", "b"]);
        assert_eq!(body, "\n# Hello\n\nbody");
    }

    #[test]
    fn write_tags_clear() {
        let text = "---\ntags: [a]\n---\nbody";
        let out = set_frontmatter_tags(text, &[]);
        assert_eq!(out, "---\ntags: []\n---\nbody");
    }

    #[test]
    fn write_tags_preserves_crlf() {
        let text = "---\r\ntags: [a]\r\n---\r\nbody";
        let out = set_frontmatter_tags(text, &["b".into()]);
        assert_eq!(out, "---\r\ntags: [\"b\"]\r\n---\r\nbody");
    }

    #[test]
    fn write_tags_escapes_quotes() {
        let out = set_frontmatter_tags("body", &["a\"b\\c".into()]);
        assert!(out.contains(r#"tags: ["a\"b\\c"]"#));
    }
}
