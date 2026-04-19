import { requestUrl } from "obsidian";
import type { AIProvider } from "./AIProvider";
import type { ProviderConfig, MessageContent } from "../types";
import { getText, getImageParts, getDocumentParts } from "./messageContent";
import { loadBinaryPart } from "./multimodal";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

interface GeminiModel {
  name: string;
  supportedGenerationMethods?: string[];
}

export class GeminiProvider implements AIProvider {
  readonly type = "gemini";
  readonly displayName = "Google Gemini";
  private config: ProviderConfig;
  private app: import("obsidian").App;

  constructor(config: ProviderConfig, app: import("obsidian").App) {
    this.config = config;
    this.app = app;
  }

  async sendMessage(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    systemPrompt: string,
    options: { maxTokens: number; temperature: number },
    _signal?: AbortSignal,
    onToken?: (chunk: string) => void
  ): Promise<string> {
    const contents = await Promise.all(
      messages.map(async (m) => {
        const role = m.role === "assistant" ? "model" : "user";
        if (typeof m.content === "string") {
          return { role, parts: [{ text: m.content }] };
        }
        const text = getText(m.content);
        const images = getImageParts(m.content);
        const documents = getDocumentParts(m.content);
        const parts: Array<Record<string, unknown>> = [];
        if (text) parts.push({ text });
        const loadedImages = await Promise.all(images.map(p => loadBinaryPart(this.app, p)));
        for (const img of loadedImages) {
          parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
        }
        const loadedDocs = await Promise.all(documents.map(p => loadBinaryPart(this.app, p)));
        for (const doc of loadedDocs) {
          parts.push({ inline_data: { mime_type: doc.mimeType, data: doc.base64 } });
        }
        return { role, parts };
      })
    );

    const url =
      `${GEMINI_BASE}/v1beta/models/${this.config.model}:generateContent` +
      `?key=${encodeURIComponent(this.config.apiKey || "")}`;

    const response = await requestUrl({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: options.maxTokens,
          temperature: options.temperature,
        },
      }),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message
        ?? `API error ${response.status}: ${(response.text ?? "").slice(0, 200)}`;
      throw new Error(message);
    }

    const candidates = response.json?.candidates as
      | Array<{ content?: { parts?: Array<{ text?: string }> } }>
      | undefined;
    const parts = candidates?.[0]?.content?.parts ?? [];
    const full = parts
      .map(p => p.text ?? "")
      .join("");

    if (full.length === 0) {
      throw new Error("No text content in Gemini response");
    }
    onToken?.(full);
    return full;
  }

  async listModels(): Promise<string[]> {
    const url = `${GEMINI_BASE}/v1beta/models?key=${encodeURIComponent(this.config.apiKey || "")}`;
    const response = await requestUrl({ url, method: "GET", throw: false });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch Gemini models: ${response.status}`);
    }

    const models = response.json?.models as GeminiModel[] | undefined;
    return (models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
      .map(m => m.name.replace("models/", ""))
      .sort();
  }

  async validateConfig(): Promise<boolean> {
    try {
      await this.sendMessage(
        [{ role: "user", content: "hi" }],
        "Reply with ok.",
        { maxTokens: 1, temperature: 0 }
      );
      return true;
    } catch {
      return false;
    }
  }
}
