/** 助研模块前端类型（与 Rust models/research.rs 对齐） */

export interface ResearchProject {
  id: number;
  title: string;
  field: string;
  description: string;
  keywords: string;
  status: "active" | "paused" | "archived" | string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProjectInput {
  title: string;
  field?: string;
  description?: string;
  keywords?: string;
  status?: string;
}

export type LiteratureStatus = "to_read" | "reading" | "read" | string;

export interface ResearchLiterature {
  id: number;
  projectId: number;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  abstractText: string;
  url: string;
  filePath: string;
  notes: string;
  tags: string;
  status: LiteratureStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchLiteratureInput {
  title: string;
  authors?: string;
  year?: number | null;
  venue?: string;
  abstractText?: string;
  url?: string;
  filePath?: string;
  notes?: string;
  tags?: string;
  status?: string;
}

export type ResearchOutputKind =
  | "frontier"
  | "review"
  | "outline"
  | "polish"
  | "format"
  | "analyze"
  | "note";

export interface ResearchOutput {
  id: number;
  projectId: number;
  kind: ResearchOutputKind;
  title: string;
  content: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchOutputInput {
  kind: ResearchOutputKind;
  title: string;
  content: string;
  sourceRef?: string;
}

export type ResearchMode =
  | "frontier"
  | "review"
  | "outline"
  | "polish"
  | "format"
  | "analyze";

export interface ResearchAiRequest {
  mode: ResearchMode;
  projectId?: number | null;
  topic?: string;
  content?: string;
  literatureIds?: number[];
  extra?: string;
  modelId?: number | null;
}

export interface ResearchAiResponse {
  content: string;
  modelName: string;
}
