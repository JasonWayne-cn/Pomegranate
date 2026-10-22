
/**
 * 编辑器 Provider 和 Hooks
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import type {
  EditorState,
  EditorContext,
  EditorEvent,
  EditorEventType,
  EditorEventCallback,
  EditorExtension,
  EditorProviderProps,
  UseEditorReturn,
} from "@/types/editor";

// ─── Editor Context ─────────────────────────────────────

interface EditorContextValue extends UseEditorReturn {
  registerExtension: (extension: EditorExtension) => () => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

// ─── Editor Provider ───────────────────────────────────

/**
 * EditorProvider 组件
 * 管理编辑器状态和生命周期
 */
export function EditorProvider({
  editor,
  children,
  noteId,
  readOnly = false,
  initialContent = "",
  onContentChange: _onContentChange,
  onSave: _onSave,
}: EditorProviderProps) {
  // 编辑器状态
  const [state, setState] = useState<EditorState>({
    content: initialContent,
    isDirty: false,
    isReadOnly: readOnly,
    isLoading: false,
    editorInstance: editor,
  });

  // 事件监听器
  const [listeners, setListeners] = useState<
    Map<EditorEventType, Map<string, EditorEventCallback>>
  >(new Map());

  // 已注册的扩展
  const [extensions, setExtensions] = useState<Map<string, EditorExtension>>(
    new Map()
  );

  // 创建编辑器上下文
  const editorContext: EditorContext | null = useMemo(() => {
    if (!editor) return null;
    return {
      noteId: noteId ?? null,
      content: state.content,
      editor,
      getState: () => state,
      setState: (newState) =>
        setState((prev) => ({ ...prev, ...newState })),
    };
  }, [editor, noteId, state]);

  // 更新状态方法
  const updateState = useCallback((newState: Partial<EditorState>) => {
    setState((prev) => ({ ...prev, ...newState }));
  }, []);

  // 获取内容
  const getContent = useCallback(() => {
    if (editor && editor.isReady()) {
      return editor.getContent();
    }
    return state.content;
  }, [editor, state.content]);

  // 设置内容
  const setContent = useCallback(
    (content: string) => {
      if (editor && editor.isReady()) {
        editor.setContent(content);
      }
      setState((prev) => ({ ...prev, content, isDirty: true }));
    },
    [editor]
  );

  // 发送事件
  const emit = useCallback(
    (event: EditorEvent) => {
      const typeListeners = listeners.get(event.type);
      if (!typeListeners) return;

      typeListeners.forEach((callback) => {
        try {
          callback(event);
        } catch (err) {
          console.error(
            `[EditorProvider] Error in event listener for ${event.type}:`,
            err
          );
        }
      });
    },
    [listeners]
  );

  // 监听事件
  const on = useCallback(
    (type: EditorEventType, callback: EditorEventCallback): (() => void) => {
      const listenerId = `${type}-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      setListeners((prev) => {
        const newListeners = new Map(prev);
        if (!newListeners.has(type)) {
          newListeners.set(type, new Map());
        }
        newListeners.get(type)!.set(listenerId, callback);
        return newListeners;
      });

      // 返回取消监听函数
      return () => {
        setListeners((prev) => {
          const newListeners = new Map(prev);
          const typeMap = newListeners.get(type);
          if (typeMap) {
            typeMap.delete(listenerId);
          }
          return newListeners;
        });
      };
    },
    []
  );

  // 注册扩展
  const registerExtension = useCallback(
    (extension: EditorExtension): (() => void) => {
      setExtensions((prev) => {
        const newExtensions = new Map(prev);
        newExtensions.set(extension.id, extension);
        return newExtensions;
      });

      // 调用 onInit
      if (editorContext && extension.onInit) {
        extension.onInit(editorContext);
      }

      // 返回取消注册函数
      return () => {
        setExtensions((prev) => {
          const newExtensions = new Map(prev);
          newExtensions.delete(extension.id);
          return newExtensions;
        });
      };
    },
    [editorContext]
  );

  // 处理编辑器初始化
  useEffect(() => {
    if (!editor) return;

    // 初始化扩展
    extensions.forEach((ext) => {
      if (ext.onInit && editorContext) {
        ext.onInit(editorContext);
      }
    });

    // 触发 init 事件
    emit({
      type: "init",
      editorId: editor.id,
      timestamp: Date.now(),
    });

    return () => {
      // 清理扩展
      extensions.forEach((ext) => {
        if (ext.onDestroy && editorContext) {
          ext.onDestroy(editorContext);
        }
      });

      // 触发 destroy 事件
      emit({
        type: "destroy",
        editorId: editor.id,
        timestamp: Date.now(),
      });

      editor.destroy();
    };
  }, [editor]); // 只在 editor 变化时重新执行

  // Context value
  const contextValue: EditorContextValue = {
    editor,
    state,
    context: editorContext,
    setState: updateState,
    getContent,
    setContent,
    emit,
    on,
    registerExtension,
  };

  return (
    <EditorContext.Provider value={contextValue}>
      {children}
    </EditorContext.Provider>
  );
}

// ─── Hooks ─────────────────────────────────────────

/**
 * 使用编辑器上下文
 */
export function useEditor(): UseEditorReturn {
  const context = useContext(EditorContext);
  if (!context) {
    throw new Error("useEditor must be used within an EditorProvider");
  }
  return context;
}

/**
 * 使用编辑器状态
 */
export function useEditorState() {
  const { state } = useEditor();
  return state;
}

/**
 * 使用编辑器内容
 */
export function useEditorContent() {
  const { state, getContent, setContent } = useEditor();
  return {
    content: state.content,
    getContent,
    setContent,
    isDirty: state.isDirty,
  };
}

/**
 * 使用编辑器事件监听
 */
export function useEditorEvent(
  type: EditorEventType,
  callback: EditorEventCallback
) {
  const { on } = useEditor();

  useEffect(() => {
    const unsubscribe = on(type, callback);
    return unsubscribe;
  }, [type, callback, on]);
}

/**
 * 使用编辑器扩展
 */
export function useEditorExtension(extension: EditorExtension) {
  const { registerExtension } = useEditor();

  useEffect(() => {
    const unsubscribe = registerExtension(extension);
    return unsubscribe;
  }, [extension, registerExtension]);
}
