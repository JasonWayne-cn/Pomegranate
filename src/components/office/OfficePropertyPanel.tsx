/** PPTX 属性面板（Phase 2）：位置尺寸、填充描边、文本样式。 */
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  ColorPicker,
  Divider,
  Empty,
  InputNumber,
  Segmented,
  Select,
  Tooltip,
  theme as antdTheme,
} from "antd";
import type { EditorNode } from "@/lib/office/editor/geometry";
import type { PptxEditOp } from "@/lib/office/editor/protocol";

interface OfficePropertyPanelProps {
  node: EditorNode | null;
  disabled?: boolean;
  onChange: (edit: PptxEditOp) => void;
  onTransform: (node: EditorNode, box: { x: number; y: number; w: number; h: number }) => void;
  onRotation: (node: EditorNode, rotDeg: number) => void;
}

const FONT_OPTIONS = [
  "Calibri",
  "Arial",
  "Times New Roman",
  "Cambria",
  "Segoe UI",
  "Aptos",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
  "Consolas",
].map((name) => ({ value: name, label: name }));

const TYPE_LABEL: Record<string, string> = {
  shape: "形状",
  text: "文本框",
  picture: "图片",
  group: "组合",
  table: "表格",
  chart: "图表",
  "placeholder-chip": "占位对象",
};

function NumField({
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value ?? null);
  useEffect(() => setDraft(value ?? null), [value]);

  const commit = () => {
    if (draft == null || draft === value) return;
    let next = draft;
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    onCommit(next);
  };

  return (
    <InputNumber
      size="small"
      className="w-full"
      value={draft}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      disabled={disabled}
      onChange={(next) => setDraft(typeof next === "number" ? next : null)}
      onBlur={commit}
      onPressEnter={commit}
    />
  );
}

export function OfficePropertyPanel({
  node,
  disabled,
  onChange,
  onTransform,
  onRotation,
}: OfficePropertyPanelProps) {
  const { token } = antdTheme.useToken();
  const style = node?.style;
  const text = style?.text;
  const locked = disabled || !node;

  function updateBox(patch: Partial<{ x: number; y: number; w: number; h: number }>) {
    if (!node) return;
    onTransform(node, {
      x: node.box.x,
      y: node.box.y,
      w: node.box.w,
      h: node.box.h,
      ...patch,
    });
  }

  return (
    <aside
      className="flex w-[280px] shrink-0 flex-col overflow-y-auto"
      style={{
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
      }}
      aria-label="属性面板"
    >
      <div
        className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-medium"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <span>属性</span>
        {node && (
          <span style={{ color: token.colorTextTertiary }}>
            {TYPE_LABEL[node.type] ?? node.type}
          </span>
        )}
      </div>

      {!node ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span className="text-xs">选中画布中的元素</span>}
          />
        </div>
      ) : (
        <div className="space-y-3 p-3">
          <section className="space-y-2">
            <div className="text-[11px] font-medium" style={{ color: token.colorTextSecondary }}>
              位置与尺寸
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                X
                <NumField value={Math.round(node.box.x)} disabled={locked} onCommit={(x) => updateBox({ x })} />
              </label>
              <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                Y
                <NumField value={Math.round(node.box.y)} disabled={locked} onCommit={(y) => updateBox({ y })} />
              </label>
              <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                宽
                <NumField
                  value={Math.round(node.box.w)}
                  min={8}
                  disabled={locked}
                  onCommit={(w) => updateBox({ w })}
                />
              </label>
              <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                高
                <NumField
                  value={Math.round(node.box.h)}
                  min={8}
                  disabled={locked}
                  onCommit={(h) => updateBox({ h })}
                />
              </label>
            </div>
            <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
              旋转
              <NumField
                value={Math.round(node.rotationDeg)}
                min={-360}
                max={360}
                suffix="°"
                disabled={locked}
                onCommit={(deg) => node && onRotation(node, deg)}
              />
            </label>
          </section>

          {(style?.canFill || style?.canStroke) && (
            <Divider className="!my-1" />
          )}

          {style?.canFill && (
            <section className="space-y-2">
              <div className="text-[11px] font-medium" style={{ color: token.colorTextSecondary }}>
                填充
              </div>
              <div className="flex items-center gap-2">
                <ColorPicker
                  size="small"
                  value={style.fillColor ?? "#ffffff"}
                  disabled={locked}
                  onChangeComplete={(color) =>
                    onChange({ kind: "fill", el: node.id, color: color.toHexString() })
                  }
                />
                <Checkbox
                  checked={style.fillKind !== "solid"}
                  disabled={locked}
                  onChange={(event) =>
                    onChange({
                      kind: "fill",
                      el: node.id,
                      color: event.target.checked ? null : "#ffffff",
                    })
                  }
                >
                  无填充
                </Checkbox>
              </div>
              {style.fillKind !== "solid" && style.fillKind !== "none" && (
                <div className="text-[11px]" style={{ color: token.colorTextTertiary }}>
                  当前为 {style.fillKind} 填充，替换为纯色会覆盖原效果。
                </div>
              )}
            </section>
          )}

          {style?.canStroke && (
            <section className="space-y-2">
              <div className="text-[11px] font-medium" style={{ color: token.colorTextSecondary }}>
                描边
              </div>
              <div className="flex items-center gap-2">
                <ColorPicker
                  size="small"
                  value={style.strokeColor ?? "#000000"}
                  disabled={locked}
                  onChangeComplete={(color) =>
                    onChange({
                      kind: "stroke",
                      el: node.id,
                      color: color.toHexString(),
                      widthPt: style.strokeWidthPt ?? 1,
                    })
                  }
                />
                <NumField
                  value={style.strokeWidthPt ?? 1}
                  min={0.25}
                  max={40}
                  step={0.25}
                  suffix="pt"
                  disabled={locked}
                  onCommit={(widthPt) =>
                    onChange({
                      kind: "stroke",
                      el: node.id,
                      color: style.strokeColor ?? "#000000",
                      widthPt,
                    })
                  }
                />
              </div>
              <Checkbox
                checked={style.strokeColor == null}
                disabled={locked}
                onChange={(event) => {
                  if (event.target.checked) {
                    onChange({ kind: "stroke", el: node.id, color: null, widthPt: 1 });
                  } else {
                    onChange({
                      kind: "stroke",
                      el: node.id,
                      color: "#000000",
                      widthPt: style.strokeWidthPt ?? 1,
                    });
                  }
                }}
              >
                无描边
              </Checkbox>
            </section>
          )}

          {text && (
            <>
              <Divider className="!my-1" />
              <section className="space-y-2">
                <div className="text-[11px] font-medium" style={{ color: token.colorTextSecondary }}>
                  文本
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                    字号
                    <NumField
                      value={text.fontSizePt}
                      min={6}
                      max={96}
                      suffix="pt"
                      disabled={locked}
                      onCommit={(fontSizePt) =>
                        onChange({ kind: "font", el: node.id, font: { fontSizePt } })
                      }
                    />
                  </label>
                  <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                    颜色
                    <div className="pt-1">
                      <ColorPicker
                        size="small"
                        value={text.color ?? "#000000"}
                        disabled={locked}
                        onChangeComplete={(color) =>
                          onChange({
                            kind: "font",
                            el: node.id,
                            font: { color: color.toHexString() },
                          })
                        }
                      />
                    </div>
                  </label>
                </div>
                <label className="space-y-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                  字体
                  <Select
                    size="small"
                    className="w-full"
                    showSearch
                    value={text.fontFamily}
                    options={
                      text.fontFamily &&
                      !FONT_OPTIONS.some((item) => item.value === text.fontFamily)
                        ? [{ value: text.fontFamily, label: text.fontFamily }, ...FONT_OPTIONS]
                        : FONT_OPTIONS
                    }
                    disabled={locked}
                    onChange={(fontFamily) =>
                      onChange({ kind: "font", el: node.id, font: { fontFamily } })
                    }
                  />
                </label>
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["B", "bold", text.bold],
                      ["I", "italic", text.italic],
                      ["U", "underline", text.underline],
                    ] as const
                  ).map(([label, key, active]) => (
                    <Tooltip key={key} title={key === "bold" ? "加粗" : key === "italic" ? "斜体" : "下划线"}>
                      <Button
                        size="small"
                        type={active ? "primary" : "default"}
                        disabled={locked}
                        style={{
                          fontWeight: key === "bold" ? 700 : undefined,
                          fontStyle: key === "italic" ? "italic" : undefined,
                          textDecoration: key === "underline" ? "underline" : undefined,
                        }}
                        onClick={() =>
                          onChange({
                            kind: "font",
                            el: node.id,
                            font: { [key]: !active },
                          })
                        }
                      >
                        {label}
                      </Button>
                    </Tooltip>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
                    对齐
                  </div>
                  <Segmented
                    size="small"
                    block
                    value={text.align ?? "left"}
                    disabled={locked}
                    options={[
                      { label: "左", value: "left" },
                      { label: "中", value: "center" },
                      { label: "右", value: "right" },
                      { label: "两端", value: "justify" },
                    ]}
                    onChange={(align) =>
                      onChange({
                        kind: "align",
                        el: node.id,
                        align: align as "left" | "center" | "right" | "justify",
                      })
                    }
                  />
                </div>
              </section>
            </>
          )}

          <div className="pt-1 text-[11px]" style={{ color: token.colorTextTertiary }}>
            位置/尺寸单位为画布 px；修改会进入撤销栈。
          </div>
        </div>
      )}
    </aside>
  );
}
