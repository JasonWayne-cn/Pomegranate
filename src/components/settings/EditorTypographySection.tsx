import {
  Button,
  Card,
  Radio,
  Select,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { Type } from "lucide-react";
import {
  useAppStore,
  EDITOR_FONT_LABELS,
  EDITOR_FONT_STACKS,
  EDITOR_FONT_SIZE_OPTIONS,
  EDITOR_LINE_HEIGHT_OPTIONS,
  EDITOR_READING_WIDTH_OPTIONS,
  EDITOR_READING_WIDTH_LABELS,
  EDITOR_RULE_LABELS,
  type EditorFontFamily,
  type EditorRuleLines,
} from "@/store";

const { Text } = Typography;

interface Props {
  compact?: boolean;
}

/**
 * 编辑器排版设置。
 *
 * 直接读写 Zustand 并即时持久化，因此不需要抽屉底部保存条。
 * 同一套设置同时作用于文档与日记编辑器。
 */
export function EditorTypographySection({ compact }: Props) {
  const editorFontFamily = useAppStore((s) => s.editorFontFamily);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const editorLineHeight = useAppStore((s) => s.editorLineHeight);
  const setEditorFontFamily = useAppStore((s) => s.setEditorFontFamily);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const setEditorLineHeight = useAppStore((s) => s.setEditorLineHeight);
  const resetEditorTypography = useAppStore((s) => s.resetEditorTypography);
  const editorReadingWidth = useAppStore((s) => s.editorReadingWidth);
  const editorPaper = useAppStore((s) => s.editorPaper);
  const editorRuleLines = useAppStore((s) => s.editorRuleLines);
  const editorFirstLineIndent = useAppStore((s) => s.editorFirstLineIndent);
  const setEditorReadingWidth = useAppStore((s) => s.setEditorReadingWidth);
  const setEditorPaper = useAppStore((s) => s.setEditorPaper);
  const setEditorRuleLines = useAppStore((s) => s.setEditorRuleLines);
  const setEditorFirstLineIndent = useAppStore((s) => s.setEditorFirstLineIndent);

  return (
    <Card
      size={compact ? "small" : "default"}
      styles={compact ? { body: { padding: 12 } } : undefined}
      title={
        <span className="flex items-center gap-2">
          <Type size={16} />
          编辑器排版
        </span>
      }
    >
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
        此设置同时作用于文档与日记编辑器，修改后立即生效。
      </Text>

      <div className="flex items-center justify-between py-1">
        <div>
          <div>正文字体</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            用户系统未装首选字体时自动 fallback 到下一项，不会出错
          </Text>
        </div>
        <Select
          value={editorFontFamily}
          onChange={(v) => setEditorFontFamily(v as EditorFontFamily)}
          style={{ width: 220 }}
          options={(Object.keys(EDITOR_FONT_LABELS) as EditorFontFamily[]).map(
            (key) => ({
              value: key,
              label: (
                <span
                  style={{
                    fontFamily:
                      (EDITOR_FONT_STACKS as Record<string, string>)[key] ||
                      undefined,
                  }}
                >
                  {(EDITOR_FONT_LABELS as Record<string, string>)[key]}
                </span>
              ),
            }),
          )}
        />
      </div>

      <div
        className="flex items-center justify-between py-1 mt-2"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
      >
        <div>
          <div>正文字号</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            标题、代码块按比例缩放
          </Text>
        </div>
        <Select
          value={editorFontSize}
          onChange={setEditorFontSize}
          style={{ width: 120 }}
          options={EDITOR_FONT_SIZE_OPTIONS.map((s) => ({
            value: s,
            label: `${s} px`,
          }))}
        />
      </div>

      <div
        className="flex items-center justify-between py-1 mt-2"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
      >
        <div>
          <div>行距</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            段落行间距倍数
          </Text>
        </div>
        <Select
          value={editorLineHeight}
          onChange={setEditorLineHeight}
          style={{ width: 120 }}
          options={EDITOR_LINE_HEIGHT_OPTIONS.map((h) => ({
            value: h,
            label: h.toFixed(1),
          }))}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>阅读列宽</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            限制正文宽度并居中，宽屏下一行不再横扫一大片
          </Text>
        </div>
        <Select
          value={editorReadingWidth}
          onChange={setEditorReadingWidth}
          style={{ width: 160 }}
          options={EDITOR_READING_WIDTH_OPTIONS.map((w) => ({
            value: w,
            label: EDITOR_READING_WIDTH_LABELS[w] ?? `${w} px`,
          }))}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>纸张观感</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            正文区变白卡 + 阴影，外层垫浅灰底，像在纸上写
          </Text>
        </div>
        <Switch checked={editorPaper} onChange={setEditorPaper} />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>背景纹理</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            横线 / 网格底纹，还原笔记本质感
          </Text>
        </div>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          size="small"
          value={editorRuleLines}
          onChange={(e) => setEditorRuleLines(e.target.value as EditorRuleLines)}
          options={(Object.keys(EDITOR_RULE_LABELS) as EditorRuleLines[]).map(
            (k) => ({ value: k, label: EDITOR_RULE_LABELS[k] }),
          )}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>首行缩进</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            顶层段落首行缩进 2 字符（中文写作习惯）
          </Text>
        </div>
        <Switch
          checked={editorFirstLineIndent}
          onChange={setEditorFirstLineIndent}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 4 }}
      >
        <div>
          <div>高亮快捷键</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            选中文字后按快捷键加/取消高亮（后续版本支持自定义键位）
          </Text>
        </div>
        <Tooltip title="当前默认快捷键 Ctrl+Shift+H">
          <Tag color="blue">Ctrl+Shift+H</Tag>
        </Tooltip>
      </div>

      <div style={{ borderTop: "1px solid #f0f0f0", marginTop: 12, paddingTop: 12 }}>
        <Text
          type="secondary"
          style={{ fontSize: 12, display: "block", marginBottom: 6 }}
        >
          预览
        </Text>
        <div
          style={{
            padding: "12px 14px",
            background: "var(--ant-color-fill-quaternary, #fafafa)",
            border: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
            borderRadius: 6,
            fontFamily:
              (EDITOR_FONT_STACKS as Record<string, string>)[editorFontFamily] ||
              undefined,
            fontSize: editorFontSize,
            lineHeight: editorLineHeight,
          }}
        >
          春有百花秋有月，夏有凉风冬有雪。
          <br />
          The quick brown fox jumps over the lazy dog. 1234567890
        </div>
        <div className="flex justify-end mt-3">
          <Button size="small" onClick={resetEditorTypography}>
            恢复默认
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default EditorTypographySection;
