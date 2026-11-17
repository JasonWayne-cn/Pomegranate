/**
 * 三维预览顶部控制条：渲染模式、着色方式、全局透明度、视角操作。
 */
import { Button, Segmented, Slider, Tooltip, theme as antdTheme } from "antd";
import { Maximize2, Sparkles } from "lucide-react";
import type { Viewer3dProjection } from "@/lib/viewer3dView";

export type Viewer3dRenderMode = "solid" | "wireframe" | "edges";
export type Viewer3dShadingMode = "smooth" | "flat";

interface Props {
  disabled: boolean;
  renderMode: Viewer3dRenderMode;
  onRenderModeChange: (mode: Viewer3dRenderMode) => void;
  shading: Viewer3dShadingMode;
  onShadingChange: (mode: Viewer3dShadingMode) => void;
  opacity: number;
  onOpacityChange: (value: number) => void;
  projection: Viewer3dProjection;
  onBestView: () => void;
  onFit: () => void;
  onToggleProjection: () => void;
}

export function Viewer3DControls({
  disabled,
  renderMode,
  onRenderModeChange,
  shading,
  onShadingChange,
  opacity,
  onOpacityChange,
  projection,
  onBestView,
  onFit,
  onToggleProjection,
}: Props) {
  const { token } = antdTheme.useToken();

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: token.colorTextSecondary,
    whiteSpace: "nowrap",
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
      style={{
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
      }}
    >
      <span style={labelStyle}>渲染</span>
      <Tooltip title="实体+边线首次生成可能较慢">
        <span>
          <Segmented
            size="small"
            disabled={disabled}
            value={renderMode}
            onChange={(value) =>
              onRenderModeChange(value as Viewer3dRenderMode)
            }
            options={[
              { label: "实体", value: "solid" },
              { label: "线框", value: "wireframe" },
              { label: "实体+边线", value: "edges" },
            ]}
          />
        </span>
      </Tooltip>

      <span style={labelStyle}>着色</span>
      <Segmented
        size="small"
        disabled={disabled}
        value={shading}
        onChange={(value) => onShadingChange(value as Viewer3dShadingMode)}
        options={[
          { label: "光滑", value: "smooth" },
          { label: "平面", value: "flat" },
        ]}
      />

      <div className="flex items-center gap-2">
        <span style={labelStyle}>不透明度</span>
        <Slider
          disabled={disabled}
          min={10}
          max={100}
          value={opacity}
          onChange={onOpacityChange}
          style={{ width: 90, margin: 0 }}
          tooltip={{ formatter: (value) => `${value}%` }}
        />
        <span
          className="w-9 text-right text-xs tabular-nums"
          style={{ color: token.colorTextSecondary }}
        >
          {opacity}%
        </span>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip title="最佳视角（前上右等轴测）">
          <Button
            size="small"
            type="text"
            disabled={disabled}
            icon={<Sparkles size={13} />}
            onClick={onBestView}
          />
        </Tooltip>
        <Tooltip title="适应窗口">
          <Button
            size="small"
            type="text"
            disabled={disabled}
            icon={<Maximize2 size={13} />}
            onClick={onFit}
          />
        </Tooltip>
        <Tooltip title="切换透视 / 正交（保持当前视角）">
          <Button size="small" type="text" disabled={disabled} onClick={onToggleProjection}>
            {projection === "orthographic" ? "正交" : "透视"}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
