import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Input,
  Radio,
  Select,
  Slider,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { Type } from "lucide-react";
import { systemApi } from "@/lib/api";
import {
  useAppStore,
  EDITOR_FONT_LABELS,
  EDITOR_FONT_STACKS,
  EDITOR_FONT_SIZE_OPTIONS,
  EDITOR_LINE_HEIGHT_OPTIONS,
  EDITOR_READING_WIDTH_OPTIONS,
  EDITOR_READING_WIDTH_LABELS,
  EDITOR_RULE_LABELS,
  EDITOR_HEADING_FONT_FOLLOW,
  type EditorFontFamily,
  type EditorFontPreset,
  type EditorRuleLines,
} from "@/store";
import type { HeadingNumberFormat } from "@/lib/headingNumber";

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
  const editorParagraphSpacing = useAppStore((s) => s.editorParagraphSpacing);
  const setEditorFontFamily = useAppStore((s) => s.setEditorFontFamily);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const setEditorLineHeight = useAppStore((s) => s.setEditorLineHeight);
  const setEditorParagraphSpacing = useAppStore((s) => s.setEditorParagraphSpacing);
  const resetEditorTypography = useAppStore((s) => s.resetEditorTypography);
  const editorReadingWidth = useAppStore((s) => s.editorReadingWidth);
  const editorPaper = useAppStore((s) => s.editorPaper);
  const editorRuleLines = useAppStore((s) => s.editorRuleLines);
  const editorFirstLineIndent = useAppStore((s) => s.editorFirstLineIndent);
  const setEditorReadingWidth = useAppStore((s) => s.setEditorReadingWidth);
  const setEditorPaper = useAppStore((s) => s.setEditorPaper);
  const setEditorRuleLines = useAppStore((s) => s.setEditorRuleLines);
  const setEditorFirstLineIndent = useAppStore((s) => s.setEditorFirstLineIndent);
  const editorTableVCenter = useAppStore((s) => s.editorTableVCenter);
  const setEditorTableVCenter = useAppStore((s) => s.setEditorTableVCenter);
  const editorHeadingNumber = useAppStore((s) => s.editorHeadingNumber);
  const setEditorHeadingNumber = useAppStore((s) => s.setEditorHeadingNumber);
  const editorHeadingNumberFormat = useAppStore((s) => s.editorHeadingNumberFormat);
  const setEditorHeadingNumberFormat = useAppStore(
    (s) => s.setEditorHeadingNumberFormat,
  );
  const editorHeadingNumberStartLevel = useAppStore(
    (s) => s.editorHeadingNumberStartLevel,
  );
  const setEditorHeadingNumberStartLevel = useAppStore(
    (s) => s.setEditorHeadingNumberStartLevel,
  );
  const editorHeadingNumberSkipManual = useAppStore(
    (s) => s.editorHeadingNumberSkipManual,
  );
  const setEditorHeadingNumberSkipManual = useAppStore(
    (s) => s.setEditorHeadingNumberSkipManual,
  );
  const editorGuideLine = useAppStore((s) => s.editorGuideLine);
  const setEditorGuideLine = useAppStore((s) => s.setEditorGuideLine);
  const editorHeadingFontFamily = useAppStore((s) => s.editorHeadingFontFamily);
  const setEditorHeadingFontFamily = useAppStore(
    (s) => s.setEditorHeadingFontFamily,
  );
  const editorCodeFontSize = useAppStore((s) => s.editorCodeFontSize);
  const setEditorCodeFontSize = useAppStore((s) => s.setEditorCodeFontSize);
  const outlinePosition = useAppStore((s) => s.outlinePosition);
  const setOutlinePosition = useAppStore((s) => s.setOutlinePosition);

  // 系统已安装字体（桌面端才有 list_system_fonts）；失败/移动端 → 空数组，UI 回退手输
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    systemApi
      .listSystemFonts()
      .then((fonts) => {
        if (alive) setSystemFonts(fonts);
      })
      .catch(() => {
        /* 枚举失败静默，回退「预设 + 手动输入」 */
      });
    return () => {
      alive = false;
    };
  }, []);
  // 当前字体是否为自选（非预设）——决定无系统字体列表时是否回填手输框
  const isCustomFont = !Object.prototype.hasOwnProperty.call(
    EDITOR_FONT_LABELS,
    editorFontFamily,
  );
  // 「正文字体」：预设分组 +（枚举成功时）系统字体分组，各项用该字体自身预览
  const fontSelectOptions = useMemo(() => {
    const preset = (Object.keys(EDITOR_FONT_LABELS) as EditorFontPreset[]).map(
      (key) => ({
        value: key as string,
        searchText: `${EDITOR_FONT_LABELS[key]} ${key}`,
        label: (
          <span style={{ fontFamily: EDITOR_FONT_STACKS[key] || undefined }}>
            {EDITOR_FONT_LABELS[key]}
          </span>
        ),
      }),
    );
    const system = systemFonts.map((name) => {
      const safe = name.replace(/["\\]/g, "");
      return {
        value: name,
        searchText: name,
        label: <span style={{ fontFamily: `"${safe}"` }}>{name}</span>,
      };
    });
    return system.length > 0
      ? [
          { label: "预设", options: preset },
          { label: `系统字体（${system.length}）`, options: system },
        ]
      : [{ label: "预设", options: preset }];
  }, [systemFonts]);
  // 「标题字体」：正文那套选项前面插一个「跟随正文」（默认值）
  const headingFontSelectOptions = useMemo(
    () => [
      {
        label: "默认",
        options: [
          {
            value: EDITOR_HEADING_FONT_FOLLOW,
            searchText: "跟随正文 follow",
            label: <span>跟随正文</span>,
          },
        ],
      },
      ...fontSelectOptions,
    ],
    [fontSelectOptions],
  );

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
            {systemFonts.length > 0
              ? "可搜索本机已装的任意字体；未装首选时自动 fallback，不会出错"
              : "未装首选字体时自动 fallback 到下一项，不会出错"}
          </Text>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            alignItems: "flex-end",
          }}
        >
          <Select
            value={editorFontFamily}
            onChange={(v) => setEditorFontFamily(v as EditorFontFamily)}
            style={{ width: 260 }}
            showSearch
            filterOption={(input, option) => {
              const opt = option as
                | { searchText?: string; value?: string }
                | undefined;
              const t = String(opt?.searchText ?? opt?.value ?? "");
              return t.toLowerCase().includes(input.trim().toLowerCase());
            }}
            options={fontSelectOptions}
          />
          {/* 枚举不可用（移动端 / 失败）时的兜底：手动输入任意字体名 */}
          {systemFonts.length === 0 && (
            <Input
              size="small"
              allowClear
              style={{ width: 260 }}
              placeholder="或手动输入字体名，回车应用"
              defaultValue={isCustomFont ? String(editorFontFamily) : ""}
              onPressEnter={(e) =>
                setEditorFontFamily(
                  (e.target as HTMLInputElement).value.trim() || "system",
                )
              }
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) setEditorFontFamily(v);
              }}
            />
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-between py-1 mt-2"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12 }}
      >
        <div>
          <div>正文字号</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            标题按比例缩放；代码块默认跟随，可在下方单独设置。编辑时 Ctrl+滚轮可快速调整，Ctrl+0 复位
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
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12 }}
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
        className="flex items-center justify-between py-1 mt-2"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12 }}
      >
        <div>
          <div>段间距</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            段落之间的垂直间隙，与行距互不影响
          </Text>
        </div>
        <div style={{ width: 180, display: "flex", alignItems: "center", gap: 8 }}>
          <Slider
            min={0}
            max={2}
            step={0.05}
            value={editorParagraphSpacing}
            onChange={setEditorParagraphSpacing}
            tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(2)} em` }}
            style={{ flex: 1, margin: 0 }}
          />
          <Text type="secondary" style={{ fontSize: 12, width: 44, textAlign: "right" }}>
            {editorParagraphSpacing.toFixed(2)}
          </Text>
        </div>
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
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
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
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
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
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
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
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
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>表格内容垂直居中</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            单元格内容在行内垂直居中；只影响显示，不写进 .md
          </Text>
        </div>
        <Switch checked={editorTableVCenter} onChange={setEditorTableVCenter} />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>标题自动编号</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            正文标题前显示 1 / 1.1 / 1.1.1 编号；纯显示，不写进 .md
          </Text>
        </div>
        <Switch
          checked={editorHeadingNumber}
          onChange={setEditorHeadingNumber}
        />
      </div>

      {editorHeadingNumber && (
        <>
          <div className="flex items-center justify-between py-1">
            <div>
              <div>编号格式</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                数字层级或中文大纲（一、/（一）/1.）
              </Text>
            </div>
            <Select
              value={editorHeadingNumberFormat}
              onChange={(v) => setEditorHeadingNumberFormat(v as HeadingNumberFormat)}
              style={{ width: 140 }}
              options={[
                { value: "decimal", label: "1 / 1.1 / 1.1.1" },
                { value: "chineseOutline", label: "一、/（一）/1." },
              ]}
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <div>起始层级</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                从第几级标题开始编号（设 2 = H1 当大标题不编号）
              </Text>
            </div>
            <Select
              value={editorHeadingNumberStartLevel}
              onChange={setEditorHeadingNumberStartLevel}
              style={{ width: 100 }}
              options={[1, 2, 3, 4, 5, 6].map((n) => ({
                value: n,
                label: `H${n}`,
              }))}
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <div>跳过手写编号</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                标题已手写「1.1 xxx」时不再叠加自动编号
              </Text>
            </div>
            <Switch
              checked={editorHeadingNumberSkipManual}
              onChange={setEditorHeadingNumberSkipManual}
            />
          </div>
        </>
      )}

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>层级引线</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            给多级列表和文档大纲画出层级竖线，嵌套关系一眼可见
          </Text>
        </div>
        <Switch checked={editorGuideLine} onChange={setEditorGuideLine} />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>标题字体</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            默认跟随正文；单独指定后 H1–H6 用该字体（正文不受影响）
          </Text>
        </div>
        <Select
          value={editorHeadingFontFamily || EDITOR_HEADING_FONT_FOLLOW}
          onChange={(v) => setEditorHeadingFontFamily(v as EditorFontFamily)}
          style={{ width: 260 }}
          showSearch
          filterOption={(input, option) => {
            const opt = option as
              | { searchText?: string; value?: string }
              | undefined;
            const t = String(opt?.searchText ?? opt?.value ?? "");
            return t.toLowerCase().includes(input.trim().toLowerCase());
          }}
          options={headingFontSelectOptions}
        />
      </div>

      <div className="flex items-center justify-between py-1">
        <div>
          <div>代码字号</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            代码块 / 行内代码字号；默认跟随正文（相对 0.9em）
          </Text>
        </div>
        <Select
          value={editorCodeFontSize}
          onChange={setEditorCodeFontSize}
          style={{ width: 140 }}
          options={[
            { value: 0, label: "跟随正文" },
            ...[12, 13, 14, 15, 16, 18, 20].map((n) => ({
              value: n,
              label: `${n}px`,
            })),
          ]}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 12 }}
      >
        <div>
          <div>大纲位置</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            文档大纲停靠在编辑区的左侧还是右侧
          </Text>
        </div>
        <Select
          value={outlinePosition}
          onChange={setOutlinePosition}
          style={{ width: 100 }}
          options={[
            { value: "left", label: "左侧" },
            { value: "right", label: "右侧" },
          ]}
        />
      </div>

      <div
        className="flex items-center justify-between py-1"
        style={{ borderTop: "1px solid var(--kb-border)", paddingTop: 12, paddingBottom: 4 }}
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

      <div style={{ borderTop: "1px solid var(--kb-border)", marginTop: 12, paddingTop: 12 }}>
        <Text
          type="secondary"
          style={{ fontSize: 12, display: "block", marginBottom: 6 }}
        >
          预览
        </Text>
        <div
          style={{
            padding: "12px 14px",
            background: "var(--ant-color-fill-quaternary, var(--kb-bg-card))",
            border: "1px solid var(--ant-color-border-secondary, var(--kb-border))",
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
