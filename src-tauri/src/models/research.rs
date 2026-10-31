//! 助研（Research Assistant）数据模型
//!
//! 面向高校科研场景的三个核心对象：
//! - 课题（Project）：一个研究方向 / 论文 / 实验项目的容器
//! - 文献（Literature）：课题下收集的论文、专著、报告
//! - 产出（Output）：AI 生成或人工整理的前沿追踪、综述、提纲、润色稿等

use serde::{Deserialize, Serialize};

// ─── 课题 ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchProject {
    pub id: i64,
    pub title: String,
    /// 学科 / 研究方向
    pub field: String,
    pub description: String,
    /// 逗号分隔的关键词
    pub keywords: String,
    /// active / paused / archived
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchProjectInput {
    pub title: String,
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub keywords: String,
    #[serde(default)]
    pub status: Option<String>,
}

// ─── 文献 ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchLiterature {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub authors: String,
    pub year: Option<i64>,
    /// 期刊 / 会议 / 出版方
    pub venue: String,
    pub abstract_text: String,
    pub url: String,
    pub file_path: String,
    /// 阅读笔记 / 摘录
    pub notes: String,
    pub tags: String,
    /// to_read / reading / read
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchLiteratureInput {
    pub title: String,
    #[serde(default)]
    pub authors: String,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub abstract_text: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub status: Option<String>,
}

// ─── 产出 ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchOutput {
    pub id: i64,
    pub project_id: i64,
    /// frontier / review / outline / polish / format / analyze / note
    pub kind: String,
    pub title: String,
    pub content: String,
    /// 来源说明（如选中的文献 id、数据文件名）
    pub source_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchOutputInput {
    pub kind: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub source_ref: String,
}

// ─── AI 生成 ────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAiRequest {
    /// frontier / review / outline / polish / format / analyze
    pub mode: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    /// 研究主题 / 论文题目 / 分析问题
    #[serde(default)]
    pub topic: String,
    /// 用户粘贴的原文、数据或补充说明
    #[serde(default)]
    pub content: String,
    /// 综述模式下选中的文献 id
    #[serde(default)]
    pub literature_ids: Vec<i64>,
    /// 额外要求（论文类型、润色风格等）
    #[serde(default)]
    pub extra: String,
    /// 指定模型；为空则使用默认模型
    #[serde(default)]
    pub model_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAiResponse {
    pub content: String,
    pub model_name: String,
}
