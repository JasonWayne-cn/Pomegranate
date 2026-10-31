import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { FormInstance } from "antd";
import {
  BarChart3,
  BookOpen,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Pencil,
  PenLine,
  Plus,
  Radar,
  Trash2,
} from "lucide-react";
import { researchApi } from "@/lib/api/research";
import type {
  ResearchLiterature,
  ResearchOutput,
  ResearchProject,
  ResearchProjectInput,
} from "@/types/research";
import { AiWorkbench } from "./AiWorkbench";
import { LiteraturePanel } from "./LiteraturePanel";
import { OutputsPanel } from "./OutputsPanel";

const { Text, Paragraph } = Typography;
const CURRENT_PROJECT_KEY = "research.currentProjectId";

const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  archived: "已归档",
};

const KIND_LABEL: Record<string, string> = {
  frontier: "前沿追踪",
  review: "文献综述",
  outline: "论文框架",
  polish: "语言润色",
  format: "规范检查",
  analyze: "数据分析",
  note: "笔记",
};

interface ProjectFormValues {
  title: string;
  field?: string;
  keywords?: string;
  status?: string;
  description?: string;
}

export default function ResearchPage() {
  const [form] = Form.useForm<ProjectFormValues>();
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [literature, setLiterature] = useState<ResearchLiterature[]>([]);
  const [outputs, setOutputs] = useState<ResearchOutput[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedLiteratureIds, setSelectedLiteratureIds] = useState<number[]>([]);
  const [writingInitialMode, setWritingInitialMode] = useState<
    "outline" | "polish" | "format" | "review"
  >("outline");
  const [writingKey, setWritingKey] = useState(0);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ResearchProject | null>(null);
  const [savingProject, setSavingProject] = useState(false);

  const currentProject = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId],
  );

  const refreshProjects = useCallback(async (preferredId?: number) => {
    setProjectsLoading(true);
    try {
      const list = await researchApi.listProjects();
      setProjects(list);
      setProjectId((prev) => {
        const wanted = preferredId ?? prev;
        if (wanted != null && list.some((item) => item.id === wanted)) {
          return wanted;
        }
        const saved = Number(localStorage.getItem(CURRENT_PROJECT_KEY));
        const savedHit = list.find((item) => item.id === saved);
        return savedHit?.id ?? list[0]?.id ?? null;
      });
    } catch (err) {
      message.error(`加载课题失败：${String(err)}`);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (projectId != null) {
      localStorage.setItem(CURRENT_PROJECT_KEY, String(projectId));
    }
  }, [projectId]);

  const loadWorkspace = useCallback(async (id: number) => {
    setWorkspaceLoading(true);
    try {
      const [literatureList, outputList] = await Promise.all([
        researchApi.listLiterature(id),
        researchApi.listOutputs(id),
      ]);
      setLiterature(literatureList);
      setOutputs(outputList);
      setSelectedLiteratureIds((prev) =>
        prev.filter((litId) => literatureList.some((item) => item.id === litId)),
      );
    } catch (err) {
      message.error(`加载课题内容失败：${String(err)}`);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId == null) {
      setLiterature([]);
      setOutputs([]);
      setSelectedLiteratureIds([]);
      return;
    }
    void loadWorkspace(projectId);
  }, [projectId, loadWorkspace]);

  function openCreateProject() {
    setEditingProject(null);
    form.resetFields();
    form.setFieldsValue({ status: "active" });
    setProjectModalOpen(true);
  }

  function openEditProject() {
    if (!currentProject) return;
    setEditingProject(currentProject);
    form.resetFields();
    form.setFieldsValue({
      title: currentProject.title,
      field: currentProject.field,
      keywords: currentProject.keywords,
      status: currentProject.status,
      description: currentProject.description,
    });
    setProjectModalOpen(true);
  }

  async function handleSaveProject() {
    let values: ProjectFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const input: ResearchProjectInput = {
      title: values.title.trim(),
      field: values.field ?? "",
      keywords: values.keywords ?? "",
      status: values.status ?? "active",
      description: values.description ?? "",
    };
    setSavingProject(true);
    try {
      if (editingProject) {
        const updated = await researchApi.updateProject(editingProject.id, input);
        setProjects((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
        message.success("课题已更新");
      } else {
        const created = await researchApi.createProject(input);
        message.success("课题已创建");
        await refreshProjects(created.id);
      }
      setProjectModalOpen(false);
    } catch (err) {
      message.error(String(err));
    } finally {
      setSavingProject(false);
    }
  }

  async function handleDeleteProject() {
    if (!currentProject) return;
    try {
      await researchApi.deleteProject(currentProject.id);
      message.success("课题已删除");
      setProjectId(null);
      await refreshProjects();
    } catch (err) {
      message.error(String(err));
    }
  }

  function refreshWorkspace() {
    if (projectId != null) void loadWorkspace(projectId);
  }

  function jumpToWriting(mode: "outline" | "polish" | "format" | "review") {
    setWritingInitialMode(mode);
    setWritingKey((key) => key + 1);
    setActiveTab("writing");
  }

  const readCount = literature.filter((item) => item.status === "read").length;
  const recentOutputs = outputs.slice(0, 5);

  if (!projectsLoading && projects.length === 0) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Card>
          <Empty
            image={<FlaskConical size={56} className="mx-auto text-blue-500" />}
            description={
              <div>
                <Typography.Title level={4} className="!mb-2">
                  开始你的第一个研究课题
                </Typography.Title>
                <Paragraph type="secondary" className="!mb-0">
                  助研工作台把课题、文献、AI 写作与数据分析放在一起。
                  先建一个课题，再收集文献，后续的综述、框架与润色都会围绕它组织。
                </Paragraph>
              </div>
            }
          >
            <Button type="primary" icon={<Plus size={14} />} onClick={openCreateProject}>
              新建课题
            </Button>
          </Empty>
        </Card>
        <ProjectModal
          form={form}
          open={projectModalOpen}
          editing={editingProject}
          saving={savingProject}
          onCancel={() => setProjectModalOpen(false)}
          onOk={() => void handleSaveProject()}
        />
      </div>
    );
  }

  const overview = currentProject ? (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card size="small">
          <Statistic title="文献总数" value={literature.length} prefix={<BookOpen size={16} />} />
        </Card>
        <Card size="small">
          <Statistic title="已读文献" value={readCount} />
        </Card>
        <Card size="small">
          <Statistic title="产出" value={outputs.length} prefix={<FileText size={16} />} />
        </Card>
        <Card size="small">
          <Statistic
            title="课题状态"
            value={STATUS_LABEL[currentProject.status] ?? currentProject.status}
            valueStyle={{ fontSize: 22 }}
          />
        </Card>
      </div>

      <Card
        title={currentProject.title}
        extra={
          <Space>
            <Tag color={currentProject.status === "active" ? "green" : "default"}>
              {STATUS_LABEL[currentProject.status] ?? currentProject.status}
            </Tag>
            <Button size="small" icon={<Pencil size={13} />} onClick={openEditProject}>
              编辑
            </Button>
          </Space>
        }
      >
        <Paragraph className="!mb-2">
          {currentProject.description || "还没有课题说明。补上研究背景与目标，AI 生成会更贴合你的方向。"}
        </Paragraph>
        <Space size={[6, 6]} wrap>
          {currentProject.field ? <Tag color="blue">{currentProject.field}</Tag> : null}
          {currentProject.keywords
            ? currentProject.keywords
                .split(/[,，\s]+/)
                .filter(Boolean)
                .map((keyword) => <Tag key={keyword}>{keyword}</Tag>)
            : null}
        </Space>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="从这里开始" size="small">
          <div className="grid grid-cols-2 gap-3">
            <QuickAction
              icon={<Radar size={18} />}
              title="追踪前沿"
              desc="热点、趋势与检索式"
              onClick={() => setActiveTab("frontier")}
            />
            <QuickAction
              icon={<BookOpen size={18} />}
              title="文献综述"
              desc="勾选文献生成初稿"
              onClick={() => {
                setActiveTab("literature");
                if (selectedLiteratureIds.length === 0) {
                  message.info("先在文献库勾选几篇文献，再生成综述");
                }
              }}
            />
            <QuickAction
              icon={<PenLine size={18} />}
              title="论文框架"
              desc="题目、摘要与章节"
              onClick={() => jumpToWriting("outline")}
            />
            <QuickAction
              icon={<BarChart3 size={18} />}
              title="数据分析"
              desc="分析思路与可视化"
              onClick={() => setActiveTab("analysis")}
            />
          </div>
        </Card>

        <Card title="最近产出" size="small" extra={<Button size="small" onClick={() => setActiveTab("outputs")}>全部</Button>}>
          {recentOutputs.length === 0 ? (
            <Text type="secondary">还没有产出。</Text>
          ) : (
            <div className="space-y-2">
              {recentOutputs.map((item) => (
                <div
                  key={item.id}
                  className="flex cursor-pointer items-center justify-between rounded-md border border-transparent px-2 py-1.5 hover:border-slate-200 hover:bg-slate-50"
                  onClick={() => setActiveTab("outputs")}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{item.title}</div>
                    <Text type="secondary" className="text-xs">
                      {KIND_LABEL[item.kind] ?? item.kind} · {item.updatedAt}
                    </Text>
                  </div>
                  <Tag className="shrink-0">{KIND_LABEL[item.kind] ?? item.kind}</Tag>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  ) : null;

  const tabItems = currentProject
    ? [
        {
          key: "overview",
          label: (
            <Space size={6}>
              <LayoutDashboard size={14} />
              概览
            </Space>
          ),
          children: overview,
        },
        {
          key: "literature",
          label: (
            <Space size={6}>
              <BookOpen size={14} />
              文献库
            </Space>
          ),
          children: (
            <LiteraturePanel
              project={currentProject}
              literature={literature}
              loading={workspaceLoading}
              selectedIds={selectedLiteratureIds}
              onSelectedChange={setSelectedLiteratureIds}
              onRefresh={refreshWorkspace}
              onGenerateReview={() => jumpToWriting("review")}
            />
          ),
        },
        {
          key: "frontier",
          label: (
            <Space size={6}>
              <Radar size={14} />
              前沿追踪
            </Space>
          ),
          children: (
            <AiWorkbench
              project={currentProject}
              literature={literature}
              selectedLiteratureIds={selectedLiteratureIds}
              modes={["frontier"]}
              initialMode="frontier"
              onSaved={refreshWorkspace}
            />
          ),
        },
        {
          key: "writing",
          label: (
            <Space size={6}>
              <PenLine size={14} />
              学术写作
            </Space>
          ),
          children: (
            <AiWorkbench
              key={writingKey}
              project={currentProject}
              literature={literature}
              selectedLiteratureIds={selectedLiteratureIds}
              modes={["outline", "review", "polish", "format"]}
              initialMode={writingInitialMode}
              onSaved={refreshWorkspace}
            />
          ),
        },
        {
          key: "analysis",
          label: (
            <Space size={6}>
              <BarChart3 size={14} />
              数据分析
            </Space>
          ),
          children: (
            <AiWorkbench
              project={currentProject}
              literature={literature}
              selectedLiteratureIds={selectedLiteratureIds}
              modes={["analyze"]}
              initialMode="analyze"
              onSaved={refreshWorkspace}
            />
          ),
        },
        {
          key: "outputs",
          label: (
            <Space size={6}>
              <FileText size={14} />
              产出
            </Space>
          ),
          children: (
            <OutputsPanel
              project={currentProject}
              outputs={outputs}
              loading={workspaceLoading}
              onRefresh={refreshWorkspace}
            />
          ),
        },
      ]
    : [];

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Typography.Title level={3} className="!mb-1">
            <Space>
              <FlaskConical size={24} />
              助研工作台
            </Space>
          </Typography.Title>
          <Text type="secondary">
            围绕课题组织文献、前沿追踪、学术写作与数据分析；AI 结果作为初稿，引用与数据需人工核验。
          </Text>
        </div>
        <Space wrap>
          <Select
            loading={projectsLoading}
            value={projectId ?? undefined}
            onChange={(value) => setProjectId(value)}
            style={{ minWidth: 240 }}
            placeholder="选择课题"
            options={projects.map((item) => ({
              value: item.id,
              label: item.title,
            }))}
          />
          <Button icon={<Plus size={14} />} onClick={openCreateProject}>
            新建课题
          </Button>
          <Button icon={<Pencil size={14} />} disabled={!currentProject} onClick={openEditProject}>
            编辑
          </Button>
          <Popconfirm
            title="删除当前课题？"
            description="课题下的文献与产出会一并删除，且不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDeleteProject()}
          >
            <Button danger icon={<Trash2 size={14} />} disabled={!currentProject}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {workspaceLoading && !currentProject ? (
        <Card loading />
      ) : (
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
        />
      )}

      <ProjectModal
        form={form}
        open={projectModalOpen}
        editing={editingProject}
        saving={savingProject}
        onCancel={() => setProjectModalOpen(false)}
        onOk={() => void handleSaveProject()}
      />
    </div>
  );
}

function QuickAction({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-lg border border-slate-200 p-3 text-left transition hover:border-blue-400 hover:bg-blue-50/40"
    >
      <span className="text-blue-600">{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-slate-500">{desc}</span>
    </button>
  );
}

function ProjectModal({
  form,
  open,
  editing,
  saving,
  onCancel,
  onOk,
}: {
  form: FormInstance<ProjectFormValues>;
  open: boolean;
  editing: ResearchProject | null;
  saving: boolean;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Modal
      title={editing ? "编辑课题" : "新建课题"}
      open={open}
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={saving}
      okText="保存"
      width={640}
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4">
        <Form.Item
          name="title"
          label="课题名称"
          rules={[{ required: true, message: "请填写课题名称" }]}
        >
          <Input placeholder="例如：薄壁零件加工变形预测方法研究" />
        </Form.Item>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Form.Item name="field" label="学科 / 研究方向">
            <Input placeholder="例如：机械制造工艺学" />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              options={[
                { value: "active", label: "进行中" },
                { value: "paused", label: "已暂停" },
                { value: "archived", label: "已归档" },
              ]}
            />
          </Form.Item>
        </div>
        <Form.Item name="keywords" label="关键词">
          <Input placeholder="逗号分隔，例如：薄壁件, 加工变形, 预测模型" />
        </Form.Item>
        <Form.Item name="description" label="课题说明">
          <Input.TextArea
            rows={4}
            placeholder="研究背景、目标、已有基础、导师要求等。会作为 AI 生成时的上下文。"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
