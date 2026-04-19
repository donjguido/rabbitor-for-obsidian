import type { ThreadMessage, MessageContent } from "../types";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function createThreadMessage(
  role: "user" | "assistant",
  content: MessageContent,
  annotationRefs: string[] = [],
  contextNoteRefs: string[] = []
): ThreadMessage {
  return {
    id: generateId(),
    role,
    content,
    timestamp: new Date().toISOString(),
    annotationRefs,
    contextNoteRefs,
  };
}

/** Parse @#N references from message content */
export function parseAnnotationRefs(content: string): string[] {
  const matches = content.match(/@#(\d+)/g);
  if (!matches) return [];
  return matches.map(m => m.slice(2));
}

/** Parse @[[Note Name]] context references from message content.
 *  Returns the note names (without @[[ and ]]).  */
export function parseContextNoteRefs(content: string): string[] {
  const matches = content.match(/@\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return matches.map(m => m.slice(3, -2));
}
