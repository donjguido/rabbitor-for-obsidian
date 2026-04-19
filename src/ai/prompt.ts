import type { Annotation } from "../types";

export interface PromptContext {
  annotation: Annotation;
  filename: string;
  referencedAnnotations?: Array<{ number: number; excerpt: string; label: string }>;
  contextNotes?: Array<{ name: string; content: string }>;
}

const NOTE_CONTENT_LIMIT = 4000;

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  parts.push(
    "You are an AI research assistant helping annotate and analyze documents."
  );
  parts.push(
    `The user has highlighted the following passage from "${ctx.filename}":`
  );
  parts.push(`\n---\n"${ctx.annotation.excerpt}"\n---`);

  if (ctx.annotation.label) {
    parts.push(`\nLabel: "${ctx.annotation.label}"`);
  }

  if (ctx.referencedAnnotations && ctx.referencedAnnotations.length > 0) {
    parts.push("\nThe user referenced these other annotations:");
    for (const ref of ctx.referencedAnnotations) {
      parts.push(`#${ref.number}: "${ref.excerpt}" (label: "${ref.label}")`);
    }
  }

  if (ctx.contextNotes && ctx.contextNotes.length > 0) {
    parts.push("\nThe user included context from these notes:");
    for (const note of ctx.contextNotes) {
      const truncated = note.content.length > NOTE_CONTENT_LIMIT
        ? note.content.slice(0, NOTE_CONTENT_LIMIT) + "\n[truncated]"
        : note.content;
      parts.push(`\n[[${note.name}]]:\n"${truncated}"`);
    }
  }

  parts.push("\nRespond thoughtfully and concisely. Use markdown formatting.");

  return parts.join("\n");
}

export { NOTE_CONTENT_LIMIT };
