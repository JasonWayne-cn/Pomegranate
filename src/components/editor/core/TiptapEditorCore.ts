
/**
 * Tiptap Editor Core 实现
 * 封装 Tiptap 编辑器，实现 EditorCore 接口
 */

import type { EditorCore, EditorConfig } from "@/types/editor";

/**
 * Tiptap Editor Core 实现类
 */
export class TiptapEditorCore implements EditorCore {
  readonly id: string;
  readonly name: string = "Tiptap Editor";
  readonly version: string = "1.0.0";
  readonly supportedFileTypes: string[] = ["md", "markdown", "txt", "text"];
  readonly features: string[] = [
    "rich-text",
    "markdown",
    "images",
    "videos",
    "tables",
    "links",
    "tasks",
    "math",
    "diagrams",
  ];

  private editorInstance: any = null;
  private config: EditorConfig;
  private ready: boolean = false;
  private content: string = "";

  constructor(config: EditorConfig = {}) {
    this.id = config.id || `tiptap-${Date.now()}`;
    this.config = config;
    this.content = config.initialContent || "";
  }

  /**
   * 设置 Tiptap 编辑器实例（由 React 组件调用）
   */
  setEditorInstance(instance: any): void {
    this.editorInstance = instance;
    this.ready = true;
  }

  /**
   * 获取当前内容
   */
  getContent(): string {
    if (this.editorInstance) {
      // 尝试从 Tiptap 实例获取 markdown
      try {
        if (this.editorInstance.storage?.markdown?.getMarkdown) {
          return this.editorInstance.storage.markdown.getMarkdown();
        }
        // 降级方案：获取 HTML 或纯文本
        return this.editorInstance.getHTML() || "";
      } catch {
        return this.editorInstance.getHTML() || "";
      }
    }
    return this.content;
  }

  /**
   * 设置编辑器内容
   */
  setContent(content: string): void {
    this.content = content;
    if (this.editorInstance) {
      try {
        this.editorInstance.commands.setContent(content, false);
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 获取当前选区
   */
  getSelection(): string {
    if (!this.editorInstance) return "";
    try {
      const { from, to } = this.editorInstance.state.selection;
      return this.editorInstance.state.doc.textBetween(from, to, " ");
    } catch {
      return "";
    }
  }

  /**
   * 替换选区内容
   */
  replaceSelection(text: string): void {
    if (!this.editorInstance) return;
    try {
      this.editorInstance.commands.insertContent(text);
    } catch {
      // 忽略错误
    }
  }

  /**
   * 在光标位置插入文本
   */
  insertText(text: string): void {
    if (!this.editorInstance) return;
    try {
      this.editorInstance.commands.insertContent(text);
    } catch {
      // 忽略错误
    }
  }

  /**
   * 聚焦编辑器
   */
  focus(): void {
    if (!this.editorInstance) return;
    try {
      this.editorInstance.commands.focus();
    } catch {
      // 忽略错误
    }
  }

  /**
   * 检查编辑器是否就绪
   */
  isReady(): boolean {
    return this.ready && this.editorInstance !== null;
  }

  /**
   * 销毁编辑器
   */
  destroy(): void {
    this.ready = false;
    this.editorInstance = null;
  }

  /**
   * 获取配置
   */
  getConfig(): EditorConfig {
    return { ...this.config };
  }
}
