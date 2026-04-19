import type { AIProvider } from "./AIProvider";
import type { ProviderConfig, MessageContent } from "../types";
import { getText, getImageParts, getDocumentParts } from "./messageContent";
import { loadBinaryPart } from "./multimodal";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

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
    signal?: AbortSignal,
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
      `${GEMINI_BASE}/v1beta/models/${this.config.model}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(this.config.apiKey || "")}`;

    const response = await fetch(url, {
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
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      let errorMessage: string;
      try {
        const parsed = JSON.parse(body);
        errorMessage = parsed?.error?.message || `API error ${response.status}`;
      } catch {
        errorMessage = `API error ${response.status}: ${body.slice(0, 200)}`;
      }
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error("No response body from Gemini stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const text = event?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            full += text;
            onToken?.(text);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be closed
      }
    }

    if (full.length === 0) {
      throw new Error("No text content in Gemini streamed response");
    }
    return full;
  }

  async listModels(): Promise<string[]> {
    const url = `${GEMINI_BASE}/v1beta/models?key=${encodeURIComponent(this.config.apiKey || "")}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch Gemini models: ${response.status}`);
    }

    const body = await response.json();
    const models: string[] = (body.models || [])
      .filter((m: any) =>
        m.supportedGenerationMethods?.includes("generateContent")
      )
      .map((m: any) => (m.name as string).replace("models/", ""))
      .sort();
    return models;
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
