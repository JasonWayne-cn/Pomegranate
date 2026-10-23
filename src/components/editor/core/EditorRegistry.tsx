
/**
 * 编辑器注册表
 * 管理所有可用的编辑器实现
 */

import React from "react";
import {
  EditorRegistry,
  EditorRegistryEntry,
  EditorConfig,
  EditorCore,
} from "@/types/editor";

/**
 * 默认编辑器注册表实现
 */
class DefaultEditorRegistry implements EditorRegistry {
  private editors: Map<string, EditorRegistryEntry> = new Map();

  /**
   * 注册编辑器
   */
  register(editor: EditorRegistryEntry): void {
    this.editors.set(editor.id, editor);
    console.log(`[EditorRegistry] Registered editor: ${editor.id} (${editor.name})`);
  }

  /**
   * 注销编辑器
   */
  unregister(id: string): void {
    this.editors.delete(id);
    console.log(`[EditorRegistry] Unregistered editor: ${id}`);
  }

  /**
   * 获取所有已注册的编辑器
   */
  getEditors(): EditorRegistryEntry[] {
    return Array.from(this.editors.values());
  }

  /**
   * 根据 ID 获取编辑器
   */
  getEditor(id: string): EditorRegistryEntry | undefined {
    return this.editors.get(id);
  }

  /**
   * 根据文件类型获取合适的编辑器
   */
  getEditorForFileType(fileType: string): EditorRegistryEntry | undefined {
    // 去掉开头的点（如果有）
    const normalizedType = fileType.toLowerCase().replace(/^\./, "");

    // 优先匹配完整扩展名
    for (const editor of this.editors.values()) {
      if (editor.supportedFileTypes.includes(normalizedType)) {
        return editor;
      }
    }

    // 如果没有匹配，尝试返回一个通用编辑器（支持 markdown 或 text）
    const fallbackTypes = ["md", "txt", "text"];
    for (const fallbackType of fallbackTypes) {
      for (const editor of this.editors.values()) {
        if (editor.supportedFileTypes.includes(fallbackType)) {
          return editor;
        }
      }
    }

    // 返回第一个可用的编辑器
    return this.editors.values().next().value;
  }

  /**
   * 根据功能特性获取编辑器列表
   */
  getEditorsByFeature(feature: string): EditorRegistryEntry[] {
    return Array.from(this.editors.values()).filter((editor) =>
      editor.features.includes(feature)
    );
  }

  /**
   * 创建编辑器实例
   */
  createEditor(id: string, config?: EditorConfig): EditorCore | null {
    const entry = this.editors.get(id);
    if (!entry) {
      console.error(`[EditorRegistry] Editor not found: ${id}`);
      return null;
    }

    const fullConfig = { ...entry.defaultConfig, ...config };
    return entry.factory(fullConfig);
  }
}

// 全局单例
export const editorRegistry = new DefaultEditorRegistry();

// React Context
const EditorRegistryContext = React.createContext<EditorRegistry>(editorRegistry);

/**
 * EditorRegistry Provider
 */
export function EditorRegistryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <EditorRegistryContext.Provider value={editorRegistry}>
      {children}
    </EditorRegistryContext.Provider>
  );
}

/**
 * Hook to use editor registry
 */
export function useEditorRegistry(): EditorRegistry {
  return React.useContext(EditorRegistryContext);
}
