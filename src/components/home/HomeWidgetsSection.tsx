import { Card, Switch, Typography, theme as antdTheme } from "antd";
import {
  useHomeWidgetsStore,
  type HomeWidgetKey,
} from "@/store/homeWidgets";

const { Text } = Typography;

interface Props {
  compact?: boolean;
}

const ITEMS: Array<{
  key: HomeWidgetKey;
  label: string;
  description: string;
}> = [
  { key: "todo", label: "今日待办", description: "今天到期与紧急任务" },
  { key: "recentNotes", label: "最近笔记", description: "最近编辑的文档" },
  { key: "pinned", label: "置顶笔记", description: "手动置顶的文档" },
  { key: "askAi", label: "AI 快捷入口", description: "首页 AI 提问卡片" },
];

/**
 * 首页卡片隐私设置。
 *
 * `blurred` 表示“模糊遮盖”，不是隐藏卡片本身；
 * 全局隐私模式（Ctrl+Shift+H）只影响当前会话，不持久化。
 */
export function HomeWidgetsSection({ compact }: Props) {
  const { token } = antdTheme.useToken();
  const blurred = useHomeWidgetsStore((s) => s.blurred);
  const toggleBlur = useHomeWidgetsStore((s) => s.toggleBlur);

  return (
    <Card
      id="settings-home-widgets"
      size={compact ? "small" : "default"}
      styles={compact ? { body: { padding: 12 } } : undefined}
      title="首页卡片隐私"
    >
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: 8, fontSize: 13 }}
      >
        开启后，对应卡片内容会在首页被模糊遮盖。全局隐私模式（Ctrl+Shift+H）会临时遮盖全部卡片，且不持久化。
      </Typography.Paragraph>

      {ITEMS.map((item, index) => (
        <div
          key={item.key}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 0",
            borderTop:
              index === 0
                ? undefined
                : `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>{item.label}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {item.description}
            </Text>
          </div>
          <Switch
            checked={blurred.has(item.key)}
            onChange={() => toggleBlur(item.key)}
            aria-label={`${item.label}隐私遮盖`}
          />
        </div>
      ))}
    </Card>
  );
}

export default HomeWidgetsSection;
