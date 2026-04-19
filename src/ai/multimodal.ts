import type { App } from "obsidian";
import type { ImagePart, ProviderConfig } from "../types";

/** Allowlist of model-name patterns known to support vision input. */
export const VISION_MODEL_PATTERNS: RegExp[] = [
  /^claude-3/i,
  /^claude-sonnet-4/i,
  /^claude-opus-4/i,
  /^claude-haiku-4/i,
  /^gpt-4o/i,
  /^gpt-4\.1/i,
  /^gpt-5/i,
  /vision/i,
  /^gemini-/i,
  /llava/i,
  /bakllava/i,
  /minicpm-v/i,
  /qwen.*vl/i,
];

export function modelLikelySupportsVision(model: string): boolean {
  return VISION_MODEL_PATTERNS.some(rx => rx.test(model));
}

/** Convert an ArrayBuffer to a base64 string. Chunked to avoid stack overflow. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, ImagePart["mimeType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] ?? "png";
}

export function extToMime(ext: string): ImagePart["mimeType"] | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null;
}

/** Load an arbitrary binary file from the vault and base64-encode it.
 *  Works for any ImagePart or DocumentPart — the MIME comes from the part,
 *  providers do not re-sniff. */
export async function loadBinaryPart(
  app: App,
  part: { vaultPath: string; mimeType: string }
): Promise<{ mimeType: string; base64: string }> {
  const buffer = await app.vault.adapter.readBinary(part.vaultPath);
  const base64 = arrayBufferToBase64(buffer);
  return { mimeType: part.mimeType, base64 };
}

/** Provider types that accept PDF document parts natively. */
export function providerSupportsDocuments(providerType: ProviderConfig["type"]): boolean {
  return providerType === "anthropic" || providerType === "gemini";
}

/** Non-image, non-pdf extensions that we attach as system-prompt context
 *  (contents are read via vault.cachedRead and inlined by prompt.ts). */
export const ATTACHABLE_TEXT_EXTENSIONS = new Set<string>([
  "txt", "md", "markdown",
  "json", "yaml", "yml", "toml", "xml", "csv", "log",
  "js", "ts", "tsx", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "php", "swift", "kt",
  "html", "htm", "css", "scss", "sass",
  "sh", "bash", "zsh", "fish",
  "sql",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export type AttachmentKind = "image" | "document" | "text" | "unknown";

/** Classify a file by extension into one of the four attach buckets.
 *  PDF is the only document MIME we support. */
export function classifyAttachmentFile(filename: string): AttachmentKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "document";
  if (ATTACHABLE_TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}
