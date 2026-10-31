import { invoke } from "@tauri-apps/api/core";
import type {
  Note,
} from "@/types";
import type {
  ResearchAiRequest,
  ResearchAiResponse,
  ResearchLiterature,
  ResearchLiteratureInput,
  ResearchOutput,
  ResearchOutputInput,
  ResearchProject,
  ResearchProjectInput,
} from "@/types/research";

export const researchApi = {
  // ─── 课题 ───────────────────────────────────
  listProjects: () =>
    invoke<ResearchProject[]>("research_list_projects"),
  createProject: (input: ResearchProjectInput) =>
    invoke<ResearchProject>("research_create_project", { input }),
  updateProject: (id: number, input: ResearchProjectInput) =>
    invoke<ResearchProject>("research_update_project", { id, input }),
  deleteProject: (id: number) =>
    invoke<boolean>("research_delete_project", { id }),

  // ─── 文献 ───────────────────────────────────
  listLiterature: (projectId: number) =>
    invoke<ResearchLiterature[]>("research_list_literature", { projectId }),
  createLiterature: (projectId: number, input: ResearchLiteratureInput) =>
    invoke<ResearchLiterature>("research_create_literature", {
      projectId,
      input,
    }),
  updateLiterature: (id: number, input: ResearchLiteratureInput) =>
    invoke<ResearchLiterature>("research_update_literature", { id, input }),
  deleteLiterature: (id: number) =>
    invoke<boolean>("research_delete_literature", { id }),

  // ─── 产出 ───────────────────────────────────
  listOutputs: (projectId: number) =>
    invoke<ResearchOutput[]>("research_list_outputs", { projectId }),
  createOutput: (projectId: number, input: ResearchOutputInput) =>
    invoke<ResearchOutput>("research_create_output", { projectId, input }),
  updateOutput: (id: number, title: string, content: string) =>
    invoke<ResearchOutput>("research_update_output", { id, title, content }),
  deleteOutput: (id: number) =>
    invoke<boolean>("research_delete_output", { id }),
  exportOutputToNote: (outputId: number, folderId?: number | null) =>
    invoke<Note>("research_export_output_to_note", { outputId, folderId }),

  // ─── AI ────────────────────────────────────
  aiGenerate: (request: ResearchAiRequest) =>
    invoke<ResearchAiResponse>("research_ai_generate", { request }),
};
