export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  vaultPath: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface DocumentPart {
  type: "document";
  vaultPath: string;
  mimeType: "application/pdf";
}

export type ContentPart = TextPart | ImagePart | DocumentPart;
export type MessageContent = string | ContentPart[];

/** A single highlight annotation on a document */
export interface Annotation {
  id: string;
  fileVaultPath: string;
  label: string;
  color: HighlightColor;
  excerpt: string;
  from: number;
  to: number;
  createdAt: string;
  updatedAt: string;
  linkedAnnotations: string[];
  thread: Thread;
}

export interface Thread {
  id: string;
  messages: ThreadMessage[];
  branches: ThreadBranch[];
  /** Map of parentMessageId → active branchId. Missing entry = original path. */
  activeBranchByParent: Record<string, string>;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: MessageContent;
  timestamp: string;
  annotationRefs: string[];
  contextNoteRefs: string[];
}

export interface ThreadBranch {
  id: string;
  parentMessageId: string;
  messages: ThreadMessage[];
  /** "fork" = divergent user-initiated branch. "regenerate" = alternate assistant reply. */
  kind: "fork" | "regenerate";
  /** ISO string — orders sibling alternates. */
  createdAt: string;
  /** User-editable for forks; unused for regenerates. */
  label?: string;
}

export type HighlightColor =
  | "purple" | "yellow" | "blue" | "green"
  | "pink" | "orange" | "red" | "teal";

export interface FileAnnotationIndex {
  [fileVaultPath: string]: string[];
}

export interface AnnotatorSettings {
  providers: ProviderConfig[];
  activeProviderId: string;
  defaultColor: HighlightColor;
  showBadges: boolean;
  showColorPicker: boolean;
  openChatAfterAnnotation: boolean;
  quickAnnotateHotkey: string;
  exportIncludeThreads: boolean;
  exportIncludeBranches: boolean;
  aiDisplayName: string;
}

export interface ProviderConfig {
  id: string;
  type: "anthropic" | "openai" | "gemini" | "openrouter" | "ollama" | "custom";
  name: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

/** Built-in slash commands that execute locally (not AI prompts) */
export type BuiltInCommandType = "skip" | "find" | "ctx" | "search" | "link" | "attach" | "export" | "copylink";

export interface BuiltInCommand {
  trigger: string;
  type: BuiltInCommandType;
  label: string;
  description: string;
  icon: string;
}

export type ParsedCommand = {
  type: "builtin";
  command: BuiltInCommandType;
  content: string;
} | {
  type: "ask";
  content: string;
};

export interface AnnotationData {
  annotations: Annotation[];
  version: number;
}

export interface ModelCacheEntry {
  providerId: string;
  models: string[];
  fetchedAt: number;
}
