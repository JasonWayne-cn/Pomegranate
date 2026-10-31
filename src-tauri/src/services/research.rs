//! 助研业务逻辑层
//!
//! 职责：
//! 1. 课题 / 文献 / 产出的 CRUD（校验 + 转调 Database 层）
//! 2. 组织科研场景提示词，调用统一的 AI 非流式补全接口
//! 3. 把产出导出为普通笔记，复用现有的笔记索引与保存链路

use std::time::Duration;

use crate::database::Database;
use crate::error::AppError;
use crate::models::research::{
    ResearchAiRequest, ResearchAiResponse, ResearchLiterature, ResearchLiteratureInput,
    ResearchOutput, ResearchOutputInput, ResearchProject, ResearchProjectInput,
};
use crate::models::Note;
use crate::services::ai::AiService;
use crate::services::note::NoteService;
use crate::models::NoteInput;

/// AI 单次生成的最长等待时间。科研类长文生成比普通问答慢，给足 3 分钟。
const AI_TIMEOUT_SECS: u64 = 180;
/// 单次交给模型的正文上限，避免超长粘贴撑爆上下文。
const MAX_INPUT_CHARS: usize = 40_000;
/// 文献摘要上限
const MAX_ABSTRACT_CHARS: usize = 1_200;
/// 综述最多纳入的文献条数
const MAX_REVIEW_LITERATURE: usize = 30;

pub struct ResearchService;

impl ResearchService {
    // ─── 课题 ───────────────────────────────────

    pub fn list_projects(db: &Database) -> Result<Vec<ResearchProject>, AppError> {
        db.list_research_projects()
    }

    pub fn create_project(
        db: &Database,
        input: &ResearchProjectInput,
    ) -> Result<ResearchProject, AppError> {
        validate_project(input)?;
        db.create_research_project(input)
    }

    pub fn update_project(
        db: &Database,
        id: i64,
        input: &ResearchProjectInput,
    ) -> Result<ResearchProject, AppError> {
        validate_project(input)?;
        db.update_research_project(id, input)
    }

    pub fn delete_project(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_research_project(id)
    }

    // ─── 文献 ───────────────────────────────────

    pub fn list_literature(
        db: &Database,
        project_id: i64,
    ) -> Result<Vec<ResearchLiterature>, AppError> {
        require_project(db, project_id)?;
        db.list_research_literature(project_id)
    }

    pub fn create_literature(
        db: &Database,
        project_id: i64,
        input: &ResearchLiteratureInput,
    ) -> Result<ResearchLiterature, AppError> {
        require_project(db, project_id)?;
        validate_literature(input)?;
        db.create_research_literature(project_id, input)
    }

    pub fn update_literature(
        db: &Database,
        id: i64,
        input: &ResearchLiteratureInput,
    ) -> Result<ResearchLiterature, AppError> {
        validate_literature(input)?;
        db.update_research_literature(id, input)
    }

    pub fn delete_literature(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_research_literature(id)
    }

    // ─── 产出 ───────────────────────────────────

    pub fn list_outputs(db: &Database, project_id: i64) -> Result<Vec<ResearchOutput>, AppError> {
        require_project(db, project_id)?;
        db.list_research_outputs(project_id)
    }

    pub fn create_output(
        db: &Database,
        project_id: i64,
        input: &ResearchOutputInput,
    ) -> Result<ResearchOutput, AppError> {
        require_project(db, project_id)?;
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("产出标题不能为空".into()));
        }
        if input.content.trim().is_empty() {
            return Err(AppError::InvalidInput("产出内容不能为空".into()));
        }
        db.create_research_output(project_id, input)
    }

    pub fn update_output(
        db: &Database,
        id: i64,
        title: &str,
        content: &str,
    ) -> Result<ResearchOutput, AppError> {
        if title.trim().is_empty() {
            return Err(AppError::InvalidInput("产出标题不能为空".into()));
        }
        db.update_research_output(id, title, content)
    }

    pub fn delete_output(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_research_output(id)
    }

    /// 把一份产出导出为普通笔记，返回新建的笔记。
    pub fn export_output_to_note(
        db: &Database,
        output_id: i64,
        folder_id: Option<i64>,
    ) -> Result<Note, AppError> {
        let output = db
            .get_research_output(output_id)?
            .ok_or_else(|| AppError::NotFound(format!("产出 {output_id} 不存在")))?;
        let title = format!("【助研】{}", output.title);
        NoteService::create(
            db,
            &NoteInput {
                title,
                content: output.content,
                folder_id,
            },
        )
    }

    // ─── AI 生成 ────────────────────────────────

    pub async fn ai_generate(
        db: &Database,
        request: ResearchAiRequest,
    ) -> Result<ResearchAiResponse, AppError> {
        let project = match request.project_id {
            Some(id) => Some(
                db.get_research_project(id)?
                    .ok_or_else(|| AppError::NotFound(format!("课题 {id} 不存在")))?,
            ),
            None => None,
        };

        let literature = if request.literature_ids.is_empty() {
            Vec::new()
        } else {
            db.get_research_literature_batch(&request.literature_ids)?
        };

        let prompt = build_prompt(&request, project.as_ref(), &literature)?;

        let model = match request.model_id {
            Some(id) => db.get_ai_model(id)?,
            None => db.get_default_ai_model()?,
        };

        let content = tokio::time::timeout(
            Duration::from_secs(AI_TIMEOUT_SECS),
            AiService::complete_once(db, &prompt, Some(model.id)),
        )
        .await
        .map_err(|_| {
            AppError::Custom(format!(
                "AI 生成超时（超过 {AI_TIMEOUT_SECS} 秒），请缩短输入或稍后重试"
            ))
        })??;

        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(AppError::Custom("AI 返回内容为空".into()));
        }

        Ok(ResearchAiResponse {
            content,
            model_name: model.name,
        })
    }
}

fn validate_project(input: &ResearchProjectInput) -> Result<(), AppError> {
    if input.title.trim().is_empty() {
        return Err(AppError::InvalidInput("课题名称不能为空".into()));
    }
    Ok(())
}

fn validate_literature(input: &ResearchLiteratureInput) -> Result<(), AppError> {
    if input.title.trim().is_empty() {
        return Err(AppError::InvalidInput("文献标题不能为空".into()));
    }
    Ok(())
}

fn require_project(db: &Database, project_id: i64) -> Result<(), AppError> {
    if db.get_research_project(project_id)?.is_none() {
        return Err(AppError::NotFound(format!("课题 {project_id} 不存在")));
    }
    Ok(())
}

fn clip(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars).collect();
    out.push_str("\n\n……（内容过长，已截断）");
    out
}

fn project_context(project: Option<&ResearchProject>) -> String {
    match project {
        None => "（未绑定课题）".to_string(),
        Some(p) => {
            let mut s = format!(
                "课题名称：{}\n研究方向：{}",
                p.title,
                blank_as(&p.field, "未填写")
            );
            if !p.keywords.trim().is_empty() {
                s.push_str(&format!("\n关键词：{}", clip(&p.keywords, 1_000)));
            }
            if !p.description.trim().is_empty() {
                s.push_str(&format!("\n课题说明：{}", clip(&p.description, 4_000)));
            }
            s
        }
    }
}

fn blank_as<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn literature_block(items: &[ResearchLiterature]) -> String {
    if items.is_empty() {
        return "（未选择文献）".to_string();
    }
    let mut out = String::new();
    for (idx, item) in items.iter().take(MAX_REVIEW_LITERATURE).enumerate() {
        out.push_str(&format!(
            "[{}] {}\n作者：{}\n年份：{}\n来源：{}\n摘要：{}\n阅读笔记：{}\n\n",
            idx + 1,
            item.title,
            blank_as(&item.authors, "未填写"),
            item.year
                .map(|y| y.to_string())
                .unwrap_or_else(|| "未填写".to_string()),
            blank_as(&item.venue, "未填写"),
            blank_as(&clip(&item.abstract_text, MAX_ABSTRACT_CHARS), "未填写"),
            blank_as(&clip(&item.notes, MAX_ABSTRACT_CHARS), "未填写"),
        ));
    }
    if items.len() > MAX_REVIEW_LITERATURE {
        out.push_str(&format!(
            "（仅纳入前 {MAX_REVIEW_LITERATURE} 篇，共 {} 篇）\n",
            items.len()
        ));
    }
    out
}

const SYSTEM_RULES: &str = "你是一名面向高校科研场景的学术研究助手。必须遵守以下规则：\n\
1. 不得虚构论文、作者、期刊、年份、DOI、基金号或实验数据。无法确认的信息必须标注“待检索验证”。\n\
2. 区分事实、推断与建议；结论要可核验，不做超出材料的因果断言。\n\
3. 使用规范、克制的中文学术表达，避免营销化措辞。\n\
4. 只输出 Markdown 正文，不要寒暄、不要解释你在做什么。";

pub(crate) fn build_prompt(
    request: &ResearchAiRequest,
    project: Option<&ResearchProject>,
    literature: &[ResearchLiterature],
) -> Result<String, AppError> {
    let topic = request.topic.trim();
    let content = clip(request.content.trim(), MAX_INPUT_CHARS);
    let extra = request.extra.trim();
    let ctx = project_context(project);

    let body = match request.mode.as_str() {
        "frontier" => {
            if topic.is_empty() {
                return Err(AppError::InvalidInput("请先填写研究主题".into()));
            }
            format!(
                "【任务】领域前沿追踪\n\n{ctx}\n\n【研究主题】\n{topic}\n\n\
【补充要求】\n{}\n\n\
请输出以下结构（Markdown）：\n\
## 一、研究热点\n3–5 个方向。每个方向包含：核心问题、代表方法与技术路线、近期进展、为什么重要。\n\
## 二、趋势判断\n归纳正在增强 / 减弱的趋势，并说明判断依据。\n\
## 三、机会与风险\n指出可切入的研究机会、可能的重复劳动与伦理/数据风险。\n\
## 四、建议检索式\n给出 5–8 组可直接用于 CNKI、Web of Science、arXiv、Google Scholar 的检索式。\n\
## 五、证据边界\n明确说明：本回答未联网检索，热点与进展基于模型已有知识，具体文献、数据与结论需逐条检索验证。",
                blank_as(extra, "无")
            )
        }
        "review" => {
            if topic.is_empty() && literature.is_empty() && content.is_empty() {
                return Err(AppError::InvalidInput(
                    "请填写研究主题、选择文献或粘贴材料后再生成综述".into(),
                ));
            }
            format!(
                "【任务】文献综述\n\n{ctx}\n\n【研究主题】\n{}\n\n\
【已选文献】\n{}\n\n【补充材料 / 说明】\n{}\n\n【额外要求】\n{}\n\n\
请输出以下结构（Markdown）：\n\
## 一、研究背景与问题界定\n\
## 二、研究脉络\n按主题或方法聚类，不要逐篇罗列；引用已选文献时使用 [1]、[2] 编号。\n\
## 三、主要观点与方法对比\n尽量使用表格，列出代表性工作、方法、数据、结论与局限。\n\
## 四、研究缺口\n\
## 五、可推进的研究问题\n给出 3–5 个具体、可执行的问题，并说明所需数据或方法。\n\
## 参考文献\n只允许列出【已选文献】中真实存在的条目；不得补充不存在文献。若未提供文献，本节写“待补充真实文献后生成”。",
                blank_as(topic, "未填写"),
                literature_block(literature),
                blank_as(&content, "无"),
                blank_as(extra, "无")
            )
        }
        "outline" => {
            if topic.is_empty() {
                return Err(AppError::InvalidInput("请先填写论文题目或研究主题".into()));
            }
            format!(
                "【任务】论文框架搭建\n\n{ctx}\n\n【论文题目 / 主题】\n{topic}\n\n\
【论文类型 / 额外要求】\n{}\n\n【已有材料】\n{}\n\n\
请输出：\n\
## 一、题目建议\n给出 3 个备选题目，并说明适用场景。\n\
## 二、摘要要点\n按“背景—问题—方法—主要发现—贡献”组织。\n\
## 三、关键词\n5–8 个。\n\
## 四、章节框架\n每章给出标题与 2–5 条写作要点；章节层级用 Markdown 标题。\n\
## 五、方法与数据建议\n说明可采用的研究设计、数据来源与分析方法。\n\
## 六、写作顺序与风险\n给出建议写作顺序，并指出最可能卡住的环节。",
                blank_as(extra, "研究论文"),
                blank_as(&content, "无")
            )
        }
        "polish" => {
            if content.is_empty() {
                return Err(AppError::InvalidInput("请先粘贴需要润色的文本".into()));
            }
            format!(
                "【任务】学术语言润色\n\n{ctx}\n\n【风格要求】\n{}\n\n【原文】\n{}\n\n\
要求：\n\
1. 保持原意、事实、数据与引用编号不变；\n\
2. 提升学术表达的准确性、简洁性与逻辑衔接；\n\
3. 先输出“## 润色后文本”，再输出“## 主要修改说明”表格（原文片段 / 修改后 / 理由）。",
                blank_as(extra, "严谨、客观、简洁"),
                content
            )
        }
        "format" => {
            if content.is_empty() {
                return Err(AppError::InvalidInput("请先粘贴需要检查的文本".into()));
            }
            format!(
                "【任务】学术写作规范检查\n\n{ctx}\n\n【检查重点】\n{}\n\n【原文】\n{}\n\n\
请检查：结构与段落逻辑、术语一致性、引用与参考文献格式、数字与单位、图表标题、\
语言冗余、主语缺失、逻辑连接词滥用等问题。\n\n\
输出：\n\
## 一、问题清单\n使用表格：位置（引用原文片段）/ 问题类型 / 修改建议 / 优先级。\n\
## 二、修改后文本\n在不改变事实的前提下给出修订稿。\n\
## 三、仍需人工确认\n列出需要作者补充或核对的信息。",
                blank_as(extra, "通用学术写作规范"),
                content
            )
        }
        "analyze" => {
            if content.is_empty() {
                return Err(AppError::InvalidInput("请先粘贴需要分析的数据或材料".into()));
            }
            format!(
                "【任务】科研数据分析\n\n{ctx}\n\n【研究问题】\n{}\n\n【数据 / 材料】\n{}\n\n【额外要求】\n{}\n\n\
要求：不得编造数据、统计量或显著性结论。\n\n\
请输出：\n\
## 一、数据概况\n字段、样本量、缺失与异常（仅基于所给材料）。\n\
## 二、可执行分析\n列出适合的分析方法与步骤，并说明前提假设。\n\
## 三、初步观察\n区分“直接可见”与“需要计算验证”。\n\
## 四、可视化建议\n给出图表类型、坐标轴与注意事项。\n\
## 五、结论与局限\n明确不能从现有材料得出的结论。",
                blank_as(topic, "未填写"),
                content,
                blank_as(extra, "无")
            )
        }
        other => {
            return Err(AppError::InvalidInput(format!("不支持的助研模式: {other}")));
        }
    };

    Ok(format!("{SYSTEM_RULES}\n\n{body}"))
}
