import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Segmented,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import {
  Copy,
  Loader2,
  Play,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { MarkdownContent } from "@/components/ai/MarkdownContent";
import { researchApi } from "@/lib/api/research";
import type { ResearchLiterature, ResearchMode, ResearchProject } from "@/types/research";

const { Text, Paragraph } = Typography;

interface ModeMeta {
  label: string;
  hint: string;
  topicLabel: string;
  contentLabel: string;
  contentPlaceholder: string;
  extraLabel: string;
  extraPlaceholder: string;
  needsTopic: boolean;
  needsContent: boolean;
}

const MODE_META: Record<ResearchMode, ModeMeta> = {
  frontier: {
    label: "前沿追踪",
    hint: "归纳研究方向的热点、趋势、机会与可检索词。",
    topicLabel: "研究主题 / 研究方向",
    contentLabel: "补充材料（可选）",
    contentPlaceholder: "可粘贴已有的摘要、项目说明或需要重点关注的线索",
    extraLabel: "额外要求（可选）",
    extraPlaceholder: "例如：偏重工程应用 / 只看近三年 / 关注方法而非结论",
    needsTopic: true,
    needsContent: false,
  },
  review: {
    label: "文献综述",
    hint: "基于文献库中勾选的条目，生成有引用编号的综述初稿。",
    topicLabel: "综述主题（可选）",
    contentLabel: "补充材料（可选）",
    contentPlaceholder: "可粘贴尚未录入文献库的摘要、提纲或研究问题",
    extraLabel: "撰写要求（可选）",
    extraPlaceholder: "例如：按方法聚类 / 控制在 2000 字 / 突出研究缺口",
    needsTopic: false,
    needsContent: false,
  },
  outline: {
    label: "框架搭建",
    hint: "生成题目、摘要要点、章节框架、方法与数据建议。",
    topicLabel: "论文题目 / 研究主题",
    contentLabel: "已有材料（可选）",
    contentPlaceholder: "可粘贴研究背景、初步结果、导师要求等",
    extraLabel: "论文类型（可选）",
    extraPlaceholder: "例如：实证研究 / 综述论文 / 开题报告 / 学位论文",
    needsTopic: true,
    needsContent: false,
  },
  polish: {
    label: "语言润色",
    hint: "保持事实与引用不变，提升学术表达的准确性与简洁性。",
    topicLabel: "论文题目（可选）",
    contentLabel: "待润色文本",
    contentPlaceholder: "粘贴需要润色的段落或章节",
    extraLabel: "风格要求（可选）",
    extraPlaceholder: "例如：更简洁 / 更严谨 / 适合期刊投稿",
    needsTopic: false,
    needsContent: true,
  },
  format: {
    label: "规范检查",
    hint: "检查结构、术语、引用格式、数字单位与语言冗余。",
    topicLabel: "论文题目（可选）",
    contentLabel: "待检查文本",
    contentPlaceholder: "粘贴需要检查的章节或全文",
    extraLabel: "检查重点（可选）",
    extraPlaceholder: "例如：参考文献格式 / 图表标题 / 术语一致性",
    needsTopic: false,
    needsContent: true,
  },
  analyze: {
    label: "数据分析",
    hint: "基于你提供的数据或材料给出分析思路、观察与局限。",
    topicLabel: "研究问题",
    contentLabel: "数据 / 材料",
    contentPlaceholder: "粘贴 CSV、表格文本、访谈摘录或实验记录",
    extraLabel: "额外要求（可选）",
    extraPlaceholder: "例如：适合什么统计检验 / 需要哪些图表 / 样本量很小",
    needsTopic: false,
    needsContent: true,
  },
};

const KIND_TAG: Record<ResearchMode, string> = {
  frontier: "前沿追踪",
  review: "文献综述",
  outline: "论文框架",
  polish: "语言润色",
  format: "规范检查",
  analyze: "数据分析",
};

function errorText(err: unknown): string {
  return String(err ?? "未知错误");
}

function showError(err: unknown) {
  const raw = errorText(err);
  if (raw.includes("\n")) {
    Modal.error({
      title: "AI 生成失败",
      content: (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
            margin: 0,
            maxHeight: 360,
            overflow: "auto",
          }}
        >
          {raw}
        </pre>
      ),
    });
  } else {
    message.error(raw);
  }
}

interface AiWorkbenchProps {
  project: ResearchProject;
  literature: ResearchLiterature[];
  selectedLiteratureIds: number[];
  modes: ResearchMode[];
  initialMode: ResearchMode;
  onSaved: () => void;
}

export function AiWorkbench({
  project,
  literature,
  selectedLiteratureIds,
  modes,
  initialMode,
  onSaved,
}: AiWorkbenchProps) {
  const [mode, setMode] = useState<ResearchMode>(initialMode);
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [extra, setExtra] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState("");
  const [modelName, setModelName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setResult("");
    setModelName("");
  }, [initialMode, project.id]);

  const meta = MODE_META[mode];
  const selectedLiterature = useMemo(
    () => literature.filter((item) => selectedLiteratureIds.includes(item.id)),
    [literature, selectedLiteratureIds],
  );

  function handleModeChange(next: ResearchMode) {
    setMode(next);
    setResult("");
    setModelName("");
  }

  function validate(): string | null {
    if (meta.needsTopic && !topic.trim()) {
      return `请填写${meta.topicLabel}`;
    }
    if (meta.needsContent && !content.trim()) {
      return `请填写${meta.contentLabel}`;
    }
    if (
      mode === "review" &&
      selectedLiterature.length === 0 &&
      !topic.trim() &&
      !content.trim()
    ) {
      return "请先在文献库勾选文献，或填写综述主题 / 补充材料";
    }
    return null;
  }

  async function handleGenerate() {
    const problem = validate();
    if (problem) {
      message.warning(problem);
      return;
    }
    setGenerating(true);
    setResult("");
    setModelName("");
    try {
      const response = await researchApi.aiGenerate({
        mode,
        projectId: project.id,
        topic: topic.trim(),
        content,
        literatureIds: mode === "review" ? selectedLiteratureIds : [],
        extra: extra.trim(),
      });
      setResult(response.content);
      setModelName(response.modelName);
    } catch (err) {
      showError(err);
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败，请手动选择文本");
    }
  }

  function openSave() {
    const base = topic.trim() || project.title;
    setSaveTitle(`${KIND_TAG[mode]} · ${base.slice(0, 30)}`);
    setSaveOpen(true);
  }

  async function handleSave() {
    if (!result) return;
    if (!saveTitle.trim()) {
      message.warning("请填写产出标题");
      return;
    }
    setSaving(true);
    try {
      await researchApi.createOutput(project.id, {
        kind: mode,
        title: saveTitle.trim(),
        content: result,
        sourceRef:
          mode === "review"
            ? `literature:${selectedLiteratureIds.join(",")}`
            : modelName,
      });
      message.success("已保存到产出");
      setSaveOpen(false);
      onSaved();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card
        title={
          <Space>
            <Sparkles size={16} />
            <span>{meta.label}</span>
          </Space>
        }
        extra={
          modes.length > 1 ? (
            <Segmented
              size="small"
              value={mode}
              onChange={(value) => handleModeChange(value as ResearchMode)}
              options={modes.map((item) => ({
                value: item,
                label: MODE_META[item].label,
              }))}
            />
          ) : null
        }
      >
        <Alert
          type="info"
          showIcon
          className="mb-4"
          message="AI 不联网检索，文献、数据与引用需人工核验"
          description="生成结果只作为初稿或线索。请勿直接引用未核实的文献、作者、年份或统计结论。"
        />

        {mode === "review" ? (
          <div className="mb-4 rounded-lg border border-dashed p-3">
            <Text type="secondary">
              已勾选 {selectedLiterature.length} 篇文献
              {selectedLiterature.length > 0 ? "：" : "（请到「文献库」勾选）"}
            </Text>
            <div className="mt-2 flex flex-wrap gap-1">
              {selectedLiterature.slice(0, 8).map((item) => (
                <Tag key={item.id} color="blue">
                  {item.title.slice(0, 28)}
                  {item.title.length > 28 ? "…" : ""}
                </Tag>
              ))}
              {selectedLiterature.length > 8 ? (
                <Tag>+{selectedLiterature.length - 8}</Tag>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          <div>
            <Text className="mb-1 block">{meta.topicLabel}</Text>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：面向薄壁零件的加工变形预测与控制"
            />
          </div>

          <div>
            <Text className="mb-1 block">{meta.contentLabel}</Text>
            <Input.TextArea
              rows={mode === "polish" || mode === "format" || mode === "analyze" ? 10 : 5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={meta.contentPlaceholder}
            />
          </div>

          <div>
            <Text className="mb-1 block">{meta.extraLabel}</Text>
            <Input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={meta.extraPlaceholder}
            />
          </div>

          <Space>
            <Button
              type="primary"
              icon={generating ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              loading={generating}
              onClick={() => void handleGenerate()}
            >
              {generating ? "生成中…" : "开始生成"}
            </Button>
            <Button
              icon={<Trash2 size={14} />}
              disabled={generating}
              onClick={() => {
                setTopic("");
                setContent("");
                setExtra("");
                setResult("");
                setModelName("");
              }}
            >
              清空
            </Button>
          </Space>
          <Paragraph type="secondary" className="!mb-0 text-xs">
            {meta.hint} 长文生成通常需要 10–60 秒。
          </Paragraph>
        </div>
      </Card>

      <Card
        title="生成结果"
        extra={
          result ? (
            <Space>
              <Tag color="purple">{KIND_TAG[mode]}</Tag>
              {modelName ? <Text type="secondary" className="text-xs">{modelName}</Text> : null}
              <Button size="small" icon={<Copy size={13} />} onClick={() => void handleCopy()}>
                复制
              </Button>
              <Button size="small" type="primary" icon={<Save size={13} />} onClick={openSave}>
                保存为产出
              </Button>
            </Space>
          ) : null
        }
      >
        {generating ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3">
            <Loader2 size={28} className="animate-spin text-blue-500" />
            <Text type="secondary">AI 正在组织内容，请稍候…</Text>
          </div>
        ) : result ? (
          <div className="ai-markdown max-h-[70vh] overflow-auto pr-1">
            <MarkdownContent>{result}</MarkdownContent>
          </div>
        ) : (
          <div className="flex min-h-[320px] items-center justify-center">
            <Text type="secondary">生成结果会显示在这里，可保存到「产出」后导出为笔记。</Text>
          </div>
        )}
      </Card>

      <Modal
        title="保存为产出"
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="保存"
      >
        <Text className="mb-1 block">标题</Text>
        <Input
          value={saveTitle}
          onChange={(e) => setSaveTitle(e.target.value)}
          placeholder="给这份产出起个名字"
        />
      </Modal>
    </div>
  );
}
