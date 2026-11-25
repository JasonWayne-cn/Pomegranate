import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, Copy, Search, Sparkles } from "lucide-react";
import { message } from "antd";
import { promptApi } from "@/lib/api";
import type { PromptTemplate } from "@/types";
import { MSheet } from "@/components/mobile/MSheet";

/**
 * 移动端提示词库（只读）。
 *
 * 提示词的增删改仍走桌面端；手机侧只做浏览、搜索、复制，
 * 避免在窄屏上复刻表单与排序拖拽。
 */
export function MobilePrompts() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [detail, setDetail] = useState<PromptTemplate | null>(null);

  useEffect(() => {
    let alive = true;
    promptApi
      .list()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e) => {
        if (alive) message.error(`加载失败: ${e}`);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.prompt.toLowerCase().includes(q),
    );
  }, [items, keyword]);

  function copyPrompt(p: PromptTemplate) {
    navigator.clipboard
      .writeText(p.prompt)
      .then(() => message.success("已复制提示词"))
      .catch((e) => message.error(`复制失败: ${e}`));
  }

  return (
    <div className="text-[var(--m-ink-1)]">
      <header className="flex h-12 items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-[var(--m-ink-2)]" />
        </button>
        <h1 className="text-base font-semibold">提示词库</h1>
        <span className="w-10" aria-hidden />
      </header>

      <div className="bg-[var(--m-surface)] px-4 pb-3 pt-2">
        <div className="flex h-10 items-center gap-2 rounded-xl bg-[var(--m-well)] px-3">
          <Search size={16} className="text-[var(--m-ink-3)]" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索标题 / 描述 / 内容"
            className="flex-1 bg-transparent text-sm text-[var(--m-ink-1)] outline-none placeholder:text-[var(--m-ink-3)]"
          />
          <span className="shrink-0 text-[11px] text-[var(--m-ink-3)]">
            {filtered.length}
          </span>
        </div>
      </div>

      <main className="bg-[var(--m-page)] pb-24">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--m-ink-3)]">
            加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-[var(--m-ink-3)]">
            <Sparkles size={40} />
            <span className="text-sm">
              {keyword.trim() ? "没有匹配的提示词" : "还没有提示词"}
            </span>
          </div>
        ) : (
          filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => setDetail(p)}
              className="mb-2 block w-full px-4 text-left active:opacity-80"
            >
              <div className="rounded-2xl bg-[var(--m-surface)] p-4">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--m-ink-1)]">
                    {p.title}
                  </span>
                  {p.isBuiltin && (
                    <span className="shrink-0 rounded bg-[var(--m-tint-primary)] px-1.5 py-0.5 text-[10px] text-[var(--m-primary)]">
                      内置
                    </span>
                  )}
                </div>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--m-ink-2)]">
                    {p.description}
                  </p>
                )}
                <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-[var(--m-ink-3)]">
                  {p.prompt}
                </p>
              </div>
            </button>
          ))
        )}
      </main>

      <MSheet
        open={detail !== null}
        title={detail?.title}
        onClose={() => setDetail(null)}
        maxHeight="80vh"
      >
        <div className="px-4 pb-4">
          <div className="whitespace-pre-wrap rounded-xl bg-[var(--m-well)] p-3 text-sm leading-relaxed text-[var(--m-ink-1)]">
            {detail?.prompt}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setDetail(null)}
              className="flex-1 rounded-xl bg-[var(--m-well)] py-2.5 text-sm font-medium text-[var(--m-ink-2)] active:opacity-70"
            >
              关闭
            </button>
            <button
              onClick={() => detail && copyPrompt(detail)}
              className="flex flex-[2] items-center justify-center gap-1 rounded-xl bg-[var(--m-primary)] py-2.5 text-sm font-medium text-[var(--m-on-primary)] active:opacity-80"
            >
              <Copy size={15} /> 复制提示词
            </button>
          </div>
        </div>
      </MSheet>
    </div>
  );
}
