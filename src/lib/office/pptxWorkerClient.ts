/**
 * Office Worker 的主线程客户端（RPC v2）。
 *
 * 每次打开创建一个 Worker 并保留；请求用自增 id 匹配，支持并发与超时。
 * 调用方负责 terminate。
 */
import type {
  DocxFontMetrics,
  DocxOpenedData,
  OfficeOpenedData,
  PptxEditOp,
  PptxSceneResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/office/editor/protocol";

export type {
  DocxFontMetrics,
  DocxOpenedData,
  DocxTextBlock,
  OfficeOpenedData,
  PptxEditOp,
  PptxInfo,
  PptxOpenedData,
  PptxSceneResult,
  PptxSlidePreviewData,
} from "@/lib/office/editor/protocol";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class PptxWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("../../workers/pptx.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleError);
    this.worker = worker;
    return worker;
  }

  private handleMessage = (event: MessageEvent<WorkerResponse>) => {
    const data = event.data;
    const call = this.pending.get(data.id);
    if (!call) return;
    this.pending.delete(data.id);
    if (call.timer) clearTimeout(call.timer);
    if (data.ok) call.resolve(data.result);
    else call.reject(new Error(data.error));
  };

  private handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || "Office Worker 异常");
    for (const call of this.pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  };

  private call<T>(
    method: WorkerRequest["method"],
    params?: unknown,
    options: { transfer?: Transferable[]; timeoutMs?: number } = {},
  ): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = { resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs > 0) {
        call.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Worker 请求超时: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, call);
      worker.postMessage({ id, method, params } satisfies WorkerRequest, options.transfer ?? []);
    });
  }

  open(
    kind: "pptx" | "docx",
    bytes: ArrayBuffer,
    fitWidth = 960,
    options?: { fontMetrics?: Record<string, DocxFontMetrics> },
  ): Promise<OfficeOpenedData> {
    // 复制一份再 transfer，避免调用方后续还要用原始字节。
    const copy = bytes.slice(0);
    return this.call<OfficeOpenedData>(
      "open",
      { kind, bytes: copy, fitWidth, fontMetrics: options?.fontMetrics },
      { transfer: [copy], timeoutMs: 0 },
    );
  }

  /** 获取单页渲染场景（命中测试/选中框用）。 */
  getScene(slide: number): Promise<PptxSceneResult> {
    return this.call<PptxSceneResult>("get-scene", { slide });
  }

  /** 提交一次语义化编辑；返回受影响页的新场景。 */
  applyOp(slide: number, edit: PptxEditOp): Promise<PptxSceneResult> {
    return this.call<PptxSceneResult>("apply-op", { slide, edit });
  }

  undo(): Promise<PptxSceneResult> {
    return this.call<PptxSceneResult>("undo");
  }

  redo(): Promise<PptxSceneResult> {
    return this.call<PptxSceneResult>("redo");
  }

  /** 显式保存：此时才序列化整个 OOXML 包。 */
  async save(): Promise<Uint8Array> {
    const result = await this.call<{ bytes: ArrayBuffer }>("save", undefined, { timeoutMs: 0 });
    return new Uint8Array(result.bytes);
  }

  updateDocxText(blockIndex: number, text: string): Promise<DocxOpenedData> {
    return this.call<DocxOpenedData>("docx-update-text", { blockIndex, text });
  }

  terminate(): void {
    const error = new Error("Worker 已终止");
    for (const call of this.pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
