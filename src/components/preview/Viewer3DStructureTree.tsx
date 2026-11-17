/**
 * 三维模型结构树。
 *
 * 节点与网格分别可切换显示/隐藏；隐藏父节点会覆盖整个子树，
 * 子节点自身的隐藏状态在父节点恢复后仍然保留。
 */
import { useState } from "react";
import { Button, Tooltip, theme as antdTheme } from "antd";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  collectAllMeshKeys,
  type Viewer3dTreeNode,
} from "@/lib/viewer3dEngine";

interface Props {
  tree: Viewer3dTreeNode;
  hiddenNodes: ReadonlySet<string>;
  hiddenMeshes: ReadonlySet<string>;
  onToggleNode: (nodeId: string) => void;
  onToggleMesh: (meshKey: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

export function Viewer3DStructureTree({
  tree,
  hiddenNodes,
  hiddenMeshes,
  onToggleNode,
  onToggleMesh,
  onShowAll,
  onHideAll,
}: Props) {
  const { token } = antdTheme.useToken();
  const meshCount = collectAllMeshKeys(tree).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-1.5 px-2 py-2"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <span className="text-xs font-medium" style={{ color: token.colorText }}>
          模型结构
        </span>
        <span className="text-[10px]" style={{ color: token.colorTextTertiary }}>
          {meshCount} 个网格
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip title="全部显示">
            <Button
              size="small"
              type="text"
              icon={<Eye size={13} />}
              onClick={onShowAll}
            />
          </Tooltip>
          <Tooltip title="全部隐藏">
            <Button
              size="small"
              type="text"
              icon={<EyeOff size={13} />}
              onClick={onHideAll}
            />
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        <TreeRow
          node={tree}
          depth={0}
          parentHidden={false}
          hiddenNodes={hiddenNodes}
          hiddenMeshes={hiddenMeshes}
          onToggleNode={onToggleNode}
          onToggleMesh={onToggleMesh}
        />
      </div>
    </div>
  );
}

interface RowProps {
  node: Viewer3dTreeNode;
  depth: number;
  parentHidden: boolean;
  hiddenNodes: ReadonlySet<string>;
  hiddenMeshes: ReadonlySet<string>;
  onToggleNode: (nodeId: string) => void;
  onToggleMesh: (meshKey: string) => void;
}

/** 单个节点下最多渲染的网格行数：flat OBJ 可能有上千个网格，避免一次铺满 DOM */
const MAX_VISIBLE_MESHES = 200;

function TreeRow({
  node,
  depth,
  parentHidden,
  hiddenNodes,
  hiddenMeshes,
  onToggleNode,
  onToggleMesh,
}: RowProps) {
  const { token } = antdTheme.useToken();
  const totalChildren = node.children.length + node.meshes.length;
  // 大模型默认折叠根节点，避免一次渲染上千行网格
  const [open, setOpen] = useState(depth === 0 && totalChildren <= 40);

  const selfHidden = hiddenNodes.has(node.id);
  const effectiveHidden = parentHidden || selfHidden;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        className="flex items-center gap-1 rounded px-1 py-0.5"
        style={{
          paddingLeft: 4 + depth * 12,
          color: effectiveHidden ? token.colorTextTertiary : token.colorText,
          cursor: hasChildren ? "pointer" : "default",
        }}
        onClick={() => {
          if (hasChildren) setOpen((value) => !value);
        }}
      >
        <span className="flex h-4 w-3 shrink-0 items-center justify-center">
          {hasChildren ? (
            open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : null}
        </span>

        <VisibilityToggle
          hidden={selfHidden}
          label={selfHidden ? "显示节点" : "隐藏节点"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleNode(node.id);
          }}
        />

        <span
          className="truncate text-xs"
          title={node.label}
          style={{ opacity: effectiveHidden ? 0.5 : 1 }}
        >
          {node.label}
        </span>

        {node.meshes.length > 0 && (
          <span
            className="ml-auto shrink-0 text-[10px] tabular-nums"
            style={{ color: token.colorTextTertiary }}
          >
            {node.meshes.length}
          </span>
        )}
      </div>

      {open && (
        <>
          {node.meshes.slice(0, MAX_VISIBLE_MESHES).map((mesh) => {
            const meshHidden = hiddenMeshes.has(mesh.key);
            const hidden = effectiveHidden || meshHidden;
            return (
              <div
                key={mesh.key}
                className="flex items-center gap-1 rounded px-1 py-0.5"
                style={{ paddingLeft: 4 + (depth + 1) * 12 }}
              >
                <span className="w-3 shrink-0" />
                <VisibilityToggle
                  hidden={meshHidden}
                  label={meshHidden ? "显示网格" : "隐藏网格"}
                  onClick={() => onToggleMesh(mesh.key)}
                />
                <span
                  className="truncate text-xs"
                  title={mesh.label}
                  style={{
                    opacity: hidden ? 0.5 : 1,
                    color: hidden ? token.colorTextTertiary : token.colorText,
                  }}
                >
                  {mesh.label}
                </span>
              </div>
            );
          })}

          {node.meshes.length > MAX_VISIBLE_MESHES && (
            <div
              className="text-[10px]"
              style={{
                paddingLeft: 4 + (depth + 1) * 12,
                color: token.colorTextTertiary,
              }}
            >
              还有 {node.meshes.length - MAX_VISIBLE_MESHES} 个网格（可用节点开关整体控制）
            </div>
          )}

          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              parentHidden={effectiveHidden}
              hiddenNodes={hiddenNodes}
              hiddenMeshes={hiddenMeshes}
              onToggleNode={onToggleNode}
              onToggleMesh={onToggleMesh}
            />
          ))}
        </>
      )}
    </>
  );
}

function VisibilityToggle({
  hidden,
  label,
  onClick,
}: {
  hidden: boolean;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { token } = antdTheme.useToken();
  return (
    <button
      type="button"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
      title={label}
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        color: hidden ? token.colorTextTertiary : token.colorPrimary,
      }}
    >
      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
    </button>
  );
}
