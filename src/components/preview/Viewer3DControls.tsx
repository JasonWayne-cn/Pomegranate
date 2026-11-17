/**
 * 三维预览顶部控制条：渲染模式、着色方式、全局透明度。
 */
import { Segmented, Slider, Tooltip, theme as antdTheme } from "antd";

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
}

export function Viewer3DControls({
  disabled,
  renderMode,
  onRenderModeChange,
  shading,
  onShadingChange,
  opacity,
  onOpacityChange,
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
    </div>
  );
}
