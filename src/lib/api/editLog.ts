/**
 * Office 编辑操作日志 API。
 *
 * 只记录操作元数据，不保存文件内容。
 */
import { invoke } from "@tauri-apps/api/core";

export interface EditOp {
  id: number;
  domain: string;
  target: string;
  source: string;
  op_json: string;
  created_at: string;
}

export const editLogApi = {
  record: (input: {
    domain: string;
    target: string;
    source: "user" | "ai" | "generate" | "import";
    opJson: string;
  }) =>
    invoke<number>("edit_log_record", {
      domain: input.domain,
      target: input.target,
      source: input.source,
      opJson: input.opJson,
    }),

  list: (target: string, limit = 50) =>
    invoke<EditOp[]>("edit_log_list", { target, limit }),

  clear: (target: string) => invoke<number>("edit_log_clear", { target }),
};
