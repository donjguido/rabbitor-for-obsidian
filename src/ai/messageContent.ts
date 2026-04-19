import type { MessageContent, ImagePart, DocumentPart, TextPart } from "../types";

/** The non-text media parts a user message can carry. */
export type MediaPart = ImagePart | DocumentPart;

/** Extract the text portion of a message content. Bare strings are returned
 *  as-is; arrays return the single TextPart's text (or "" if absent). */
export function getText(content: MessageContent): string {
  if (typeof content === "string") return content;
  const text = content.find((p): p is TextPart => p.type === "text");
  return text?.text ?? "";
}

/** Extract the image parts of a message content. */
export function getImageParts(content: MessageContent): ImagePart[] {
  if (typeof content === "string") return [];
  return content.filter((p): p is ImagePart => p.type === "image");
}

/** Extract the document parts of a message content. */
export function getDocumentParts(content: MessageContent): DocumentPart[] {
  if (typeof content === "string") return [];
  return content.filter((p): p is DocumentPart => p.type === "document");
}

/** Build a MessageContent from a text body and a list of media parts.
 *  - If `media` is empty, returns the bare string (canonical text-only form).
 *  - Otherwise, returns `[{type:"text", text}, ...media]`.
 *  Invariant: ContentPart[] always has exactly one TextPart first, followed
 *  by zero or more MediaParts (images and/or documents). */
export function makeContent(text: string, media: MediaPart[]): MessageContent {
  if (media.length === 0) return text;
  return [{ type: "text", text }, ...media];
}
