import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Skeleton,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  message,
  theme as antdTheme,
} from "antd";
import { ArrowRight } from "lucide-react";
import { moduleConfigApi } from "@/lib/api";
import type { AppConfig } from "@/types";
import {
  MODULE_CONFIG_CHANGED_EVENT,
  parseFieldValue,
  resolveStorageKey,
  serializeFieldValue,
  type ModuleConfigField,
  type ModuleMeta,
  type ModulePanelComponentProps,
  type ModulePanelDef,
} from "@/modules/types";

interface Props {
  meta: ModuleMeta;
  /** URL 深链要定位的面板 id */
  focusPanelId?: string | null;
}

/**
 * 模块配置面板。
 *
 * · schema 面板：由本组件统一读取 / 保存
 * · component 面板：懒加载现有设置组件，组件内部自行保存
 * · link 面板：仅提供跳转
 */
export function ModuleConfigPanel({ meta, focusPanelId }: Props) {
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const groups = meta.groups;
  const hasGroups = !!groups?.length;
  const [activeGroup, setActiveGroup] = useState(() => groups?.[0]?.id ?? "");

  // 模块切换或分组定义变化时，保证 activeGroup 合法
  useEffect(() => {
    if (!groups?.length) return;
    if (!groups.some((g) => g.id === activeGroup)) {
      setActiveGroup(groups[0].id);
    }
  }, [groups, activeGroup]);

  // 深链定位：先切到面板所属分组，再滚动并高亮
  useEffect(() => {
    if (!focusPanelId) return;
    const panel = meta.panels.find((p) => p.id === focusPanelId);
    if (panel?.group && groups?.some((g) => g.id === panel.group)) {
      setActiveGroup(panel.group);
    }
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`module-panel-${focusPanelId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("module-panel-focus");
      window.setTimeout(() => el.classList.remove("module-panel-focus"), 1600);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [focusPanelId, meta.panels, groups]);

  /** 所有 schema 字段，用于初始加载与默认值 */
  const allSchemaFields = useMemo(
    () =>
      meta.panels
        .filter((p) => p.kind === "schema")
        .flatMap((p) => p.fields ?? []),
    [meta.panels],
  );

  /** 当前分组的面板；未定义 groups 时即全部面板 */
  const activePanels = useMemo(() => {
    if (!hasGroups) return meta.panels;
    return meta.panels.filter(
      (p) => (p.group ?? groups![0].id) === activeGroup,
    );
  }, [meta.panels, hasGroups, groups, activeGroup]);

  const activeSchemaPanels = useMemo(
    () => activePanels.filter((p) => p.kind === "schema"),
    [activePanels],
  );
  const activeSchemaFields = useMemo(
    () => activeSchemaPanels.flatMap((p) => p.fields ?? []),
    [activeSchemaPanels],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);

    const defaults = buildFormValues(meta, allSchemaFields, {});

    if (allSchemaFields.length === 0) {
      form.setFieldsValue(defaults);
      setLoading(false);
      return;
    }

    const keys = allSchemaFields.map((field) => resolveStorageKey(meta, field));
    moduleConfigApi
      .getMany(keys)
      .then((stored) => {
        if (!alive) return;
        form.setFieldsValue(buildFormValues(meta, allSchemaFields, stored));
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(String(e));
        // 读取失败时仍展示默认值，避免整块面板空白
        form.setFieldsValue(defaults);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
    // meta/allSchemaFields 由 registry 静态提供，稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.view]);

  async function handleSave() {
    if (activeSchemaFields.length === 0) return;
    setSaving(true);
    try {
      const values = await form.validateFields(
        activeSchemaFields.map((field) => field.key),
      );
      const entries: AppConfig[] = activeSchemaFields.map((field) => ({
        key: resolveStorageKey(meta, field),
        value: serializeFieldValue(field, values[field.key]),
      }));
      await moduleConfigApi.setMany(entries);
      window.dispatchEvent(
        new CustomEvent(MODULE_CONFIG_CHANGED_EVENT, { detail: { view: meta.view } }),
      );
      const restart = activeSchemaFields.some((f) => f.requiresRestart);
      message.success(
        restart ? "配置已保存，部分设置需要重新进入页面后生效" : "配置已保存",
      );
    } catch (e) {
      if (isValidationError(e)) return;
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * 纯展示类开关（instantApply）：改动即写入 app_config 并广播，
   * 让文件夹树/编辑器等界面立刻跟随，不必等底部「保存」。
   */
  async function persistInstantFields(changed: Record<string, unknown>) {
    for (const key of Object.keys(changed)) {
      const field = allSchemaFields.find(
        (f) => f.key === key && f.instantApply,
      );
      if (!field) continue;
      try {
        await moduleConfigApi.setMany([
          {
            key: resolveStorageKey(meta, field),
            value: serializeFieldValue(field, form.getFieldValue(key)),
          },
        ]);
        window.dispatchEvent(
          new CustomEvent(MODULE_CONFIG_CHANGED_EVENT, {
            detail: { view: meta.view },
          }),
        );
      } catch (e) {
        message.error(`保存失败：${e}`);
      }
    }
  }

  function handleReset() {
    form.setFieldsValue(buildFormValues(meta, activeSchemaFields, {}));
    message.info("已恢复默认值，点击「保存」后生效");
  }

  if (loading) {
    return (
      <div style={{ padding: "20px 24px" }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  function renderPanels(panels: ModulePanelDef[]) {
    const schema = panels.filter((p) => p.kind === "schema");
    const others = panels.filter((p) => p.kind !== "schema");

    return (
      <>
        {schema.map((panel) => (
          <Card
            key={panel.id}
            id={`module-panel-${panel.id}`}
            size="small"
            title={panel.title}
            style={{ marginBottom: 16 }}
            styles={{ body: { paddingBottom: 4 } }}
          >
            {/* 两列网格：span:1 的相邻字段自动并排一行，其余字段整行铺满 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                columnGap: 16,
              }}
            >
              {(panel.fields ?? []).map((field) => (
                <div
                  key={field.key}
                  style={{ gridColumn: field.span === 1 ? "span 1" : "1 / -1" }}
                >
                  <FieldItem field={field} />
                </div>
              ))}
            </div>
          </Card>
        ))}

        {others.map((panel) => (
          <OtherPanel
            key={panel.id}
            panel={panel}
            onNavigate={(to) => navigate(to)}
          />
        ))}
      </>
    );
  }

  const groupPanels = (groupId: string) =>
    meta.panels.filter((p) => (p.group ?? groups![0].id) === groupId);

  const formContent = (
    <Form
      form={form}
      layout="vertical"
      disabled={saving}
      onValuesChange={(changed) => void persistInstantFields(changed)}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {hasGroups ? (
        <Tabs
          className="module-subtabs"
          activeKey={activeGroup}
          onChange={setActiveGroup}
          items={groups!.map((group) => {
            const panels = groupPanels(group.id);
            return {
              key: group.id,
              label: group.label,
              children: (
                <div className="module-subtab-scroll">
                  {panels.length === 0 ? (
                    <Empty description="该分组暂无可配置项" />
                  ) : (
                    renderPanels(panels)
                  )}
                </div>
              ),
            };
          })}
        />
      ) : (
        <div className="module-subtab-scroll">
          {meta.panels.length === 0 ? (
            <Empty description="该模块暂无可配置项" />
          ) : (
            renderPanels(meta.panels)
          )}
        </div>
      )}
    </Form>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {loadError && (
        <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
          <Alert
            type="warning"
            showIcon
            message="读取已有配置失败，当前显示默认值"
            description={loadError}
          />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {formContent}
      </div>

      {activeSchemaFields.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: token.colorBgContainer,
          }}
        >
          <Button onClick={handleReset} disabled={saving}>
            恢复默认
          </Button>
          <Space>
            <Button
              type="primary"
              loading={saving}
              onClick={() => void handleSave()}
            >
              保存
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}

function FieldItem({ field }: { field: ModuleConfigField }) {
  const extra =
    field.description || field.requiresRestart ? (
      <span>
        {field.description}
        {field.requiresRestart && (
          <Tag color="orange" style={{ marginLeft: 6 }}>
            需重启
          </Tag>
        )}
      </span>
    ) : undefined;

  let control: ReactNode;
  switch (field.type) {
    case "switch":
      return (
        <Form.Item
          name={field.key}
          label={field.label}
          extra={extra}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      );
    case "select":
      control = (
        <Select
          options={field.options}
          placeholder={field.placeholder ?? "请选择"}
          // 与同行的 number 输入框等宽（都撑满所在的半宽列）
          style={{ width: "100%" }}
        />
      );
      break;
    case "number":
      control = (
        <InputNumber
          min={field.min}
          max={field.max}
          step={field.step}
          // 用 suffix 而非 addonAfter：addonAfter 会多包一层 group wrapper，
          // 宽度不吃 100%，导致与同行 Select 不等宽
          suffix={field.unit}
          style={{ width: "100%" }}
          placeholder={field.placeholder}
        />
      );
      break;
    case "slider":
      control = (
        <Slider
          min={field.min}
          max={field.max}
          step={field.step}
          marks={field.min != null && field.max != null ? {
            [field.min]: String(field.min),
            [field.max]: String(field.max),
          } : undefined}
        />
      );
      break;
    case "textarea":
      control = (
        <Input.TextArea
          rows={4}
          placeholder={field.placeholder}
          showCount
        />
      );
      break;
    case "time":
      control = <Input type="time" style={{ width: 160 }} />;
      break;
    default:
      control = <Input placeholder={field.placeholder} />;
  }

  return (
    <Form.Item name={field.key} label={field.label} extra={extra}>
      {control}
    </Form.Item>
  );
}

function OtherPanel({
  panel,
  onNavigate,
}: {
  panel: ModulePanelDef;
  onNavigate: (to: string) => void;
}) {
  // 复杂组件通常自带 Card 标题；再包一层会出现双层卡片
  if (panel.kind === "component") {
    return (
      <div id={`module-panel-${panel.id}`} style={{ marginBottom: 16 }}>
        {panel.description && (
          <p style={{ margin: "0 0 12px", opacity: 0.72, fontSize: 13 }}>
            {panel.description}
          </p>
        )}
        {panel.load && <LazyPanel panel={panel} />}
      </div>
    );
  }

  return (
    <Card
      id={`module-panel-${panel.id}`}
      size="small"
      title={panel.title}
      style={{ marginBottom: 16 }}
    >
      {panel.description && (
        <p style={{ margin: "0 0 12px", opacity: 0.72, fontSize: 13 }}>
          {panel.description}
        </p>
      )}
      {panel.kind === "link" && panel.link && (
        <Button
          type="link"
          style={{ paddingLeft: 0 }}
          onClick={() => onNavigate(panel.link!.to)}
        >
          {panel.link.label} <ArrowRight size={14} />
        </Button>
      )}
    </Card>
  );
}

function LazyPanel({ panel }: { panel: ModulePanelDef }) {
  const [Comp, setComp] = useState<ComponentType<ModulePanelComponentProps> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setComp(null);
    setError(null);

    panel
      .load?.()
      .then((mod) => {
        if (alive) setComp(() => mod.default);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });

    return () => {
      alive = false;
    };
  }, [panel]);

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="设置组件加载失败"
        description={error}
      />
    );
  }
  if (!Comp) return <Skeleton active paragraph={{ rows: 4 }} />;
  return <Comp compact />;
}

function buildFormValues(
  meta: ModuleMeta,
  fields: ModuleConfigField[],
  stored: Record<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const storageKey = resolveStorageKey(meta, field);
    values[field.key] = parseFieldValue(field, stored[storageKey]);
  }
  return values;
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errorFields" in (error as Record<string, unknown>)
  );
}
