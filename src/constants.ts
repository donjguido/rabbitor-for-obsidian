import type { AnnotatorSettings, BuiltInCommand, HighlightColor } from "./types";

export const VIEW_TYPE_ANNOTATOR = "annotator-view";

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "purple", "yellow", "blue", "green",
  "pink", "orange", "red", "teal",
];

export const DEFAULT_SETTINGS: AnnotatorSettings = {
  providers: [],
  activeProviderId: "",
  defaultColor: "yellow",
  showBadges: true,
  showColorPicker: true,
  openChatAfterAnnotation: true,
  quickAnnotateHotkey: "Ctrl+Shift+H",
  exportIncludeThreads: true,
  exportIncludeBranches: false,
  aiDisplayName: "Claude",
};

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    trigger: "/skip",
    type: "skip",
    label: "Skip",
    description: "Leave a comment without asking the AI",
    icon: "message-square",
  },
  {
    trigger: "/find",
    type: "find",
    label: "Find",
    description: "Search within the document text",
    icon: "search",
  },
  {
    trigger: "/ctx",
    type: "ctx",
    label: "Context",
    description: "Include full document context for this prompt",
    icon: "file-text",
  },
  {
    trigger: "/search",
    type: "search",
    label: "Web search",
    description: "Ask the AI with web search enabled",
    icon: "globe",
  },
  {
    trigger: "/link",
    type: "link",
    label: "Link",
    description: "Link to another annotation (@#N)",
    icon: "link",
  },
  {
    trigger: "/attach",
    type: "attach",
    label: "Attach",
    description: "Attach files (images, PDFs, or text) to this message",
    icon: "paperclip",
  },
  {
    trigger: "/export",
    type: "export",
    label: "Export",
    description: "Export this annotation to a new note",
    icon: "file-output",
  },
  {
    trigger: "/copylink",
    type: "copylink",
    label: "Copy link",
    description: "Copy a link to this annotation's chat",
    icon: "clipboard-copy",
  },
];

export const DATA_VERSION = 1;
