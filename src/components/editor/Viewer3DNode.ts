/**
 * Tiptap 三维模型节点。
 *
 * 设计：
 * - 块级 atom 节点，文档里只存 `kb-asset://<rel>`，与数据目录解耦
 * - 渲染为一张卡片（NodeView），点击"预览"打开全局附件预览 Modal 里的三维查看器；
 *   不在编辑器内挂 WebGL，避免多实例上下文与滚动卡顿
 * - 序列化为带 data 属性的 div，依赖 tiptap-markdown `html: true` 透传：
 *
 *   <div data-viewer3d-src="kb-asset://..." data-viewer3d-name="model.stl"
 *        data-viewer3d-size="12345"></div>
 *
 * - div 内保留一个链接作为导出/打印兜底；parseHTML 只认 data-viewer3d-src，
 *   不会把普通 div 吞成三维节点
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Viewer3DNodeView } from "./Viewer3DNodeView";

export interface Viewer3DNodeOptions {
  HTMLAttributes: Record<string, unknown>;
}

export interface Viewer3DAttrs {
  src: string;
  name: string;
  size: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    viewer3d: {
      setViewer3D: (attrs: Viewer3DAttrs) => ReturnType;
    };
  }
}

export const Viewer3DNode = Node.create<Viewer3DNodeOptions>({
  name: "viewer3d",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {
        class: "tiptap-viewer3d",
      },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-viewer3d-src"),
        renderHTML: (attrs) =>
          attrs.src ? { "data-viewer3d-src": attrs.src as string } : {},
      },
      name: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-viewer3d-name"),
        renderHTML: (attrs) =>
          attrs.name ? { "data-viewer3d-name": attrs.name as string } : {},
      },
      size: {
        default: 0,
        parseHTML: (el) => {
          const raw = Number(el.getAttribute("data-viewer3d-size"));
          return Number.isFinite(raw) && raw > 0 ? raw : 0;
        },
        renderHTML: (attrs) => ({
          "data-viewer3d-size": String(
            Number.isFinite(attrs.size) ? attrs.size : 0,
          ),
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-viewer3d-src]",
        getAttrs: (el) => {
          const src = el.getAttribute("data-viewer3d-src");
          if (!src) return false;
          return {
            src,
            name: el.getAttribute("data-viewer3d-name") ?? null,
            size: Number(el.getAttribute("data-viewer3d-size")) || 0,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const name = (node.attrs.name as string | null) || "三维模型";
    const src = (node.attrs.src as string | null) || "";
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      ["a", { href: src }, `三维模型：${name}`],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(Viewer3DNodeView);
  },

  addCommands() {
    return {
      setViewer3D:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },
});
