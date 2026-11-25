import { useEffect, useRef, useState } from "react";
import { MSheet } from "./MSheet";

/**
 * 移动端单行文本输入面板。
 *
 * 替代 `window.prompt`（Android WebView 里样式突兀、可被环境禁用、无法校验）。
 * 用于：新建子任务、新建标签名等「一句话输入」场景。
 */
export interface TextPromptModalProps {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  maxLength?: number;
  confirmText?: string;
  onClose: () => void;
  onSubmit: (value: string) => void | Promise<void>;
}

export function TextPromptModal({
  open,
  title,
  placeholder,
  initialValue = "",
  maxLength = 80,
  confirmText = "确定",
  onClose,
  onSubmit,
}: TextPromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setSubmitting(false);
    // 等入场动画结束再 focus，否则部分 Android WebView 拉不起键盘
    const t = window.setTimeout(() => inputRef.current?.focus(), 140);
    return () => window.clearTimeout(t);
  }, [open, initialValue]);

  async function submit() {
    const v = value.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(v);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MSheet open={open} title={title} onClose={onClose} keyboardAware maxHeight="55vh">
      <div className="px-4 pb-3">
        <input
          ref={inputRef}
          value={value}
          maxLength={maxLength}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder={placeholder}
          className="w-full rounded-xl bg-[var(--m-well)] px-4 py-3 text-base text-[var(--m-ink-1)] outline-none placeholder:text-[var(--m-ink-3)]"
        />
      </div>
      <div className="flex gap-3 px-4 pb-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl bg-[var(--m-well)] text-base font-medium text-[var(--m-ink-2)] active:opacity-70"
          style={{ minHeight: 48 }}
        >
          取消
        </button>
        <button
          onClick={() => void submit()}
          disabled={!value.trim() || submitting}
          className="flex-[2] rounded-xl bg-[var(--m-primary)] text-base font-medium text-[var(--m-on-primary)] active:opacity-80 disabled:opacity-40"
          style={{ minHeight: 48 }}
        >
          {confirmText}
        </button>
      </div>
    </MSheet>
  );
}
