import { requestUrl } from "obsidian";
import type { AIProvider } from "./AIProvider";
import type { ProviderConfig, MessageContent } from "../types";
import { getText, getImageParts, getDocumentParts } from "./messageContent";
import { loadBinaryPart } from "./multimodal";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

export class OpenAICompatibleProvider implements AIProvider {
  readonly type: string;
  readonly displayName: string;
  private config: ProviderConfig;
  private baseUrl: string;
  private app: import("obsidian").App;

  constructor(config: ProviderConfig, app: import("obsidian").App) {
    this.config = config;
    this.app = app;
    this.type = config.type;
    this.displayName = config.name;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URLS[config.type] || "").replace(/\/+$/, "");
  }

  async sendMessage(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    systemPrompt: string,
    options: { maxTokens: number; temperature: number },
    _signal?: AbortSignal,
    onToken?: (chunk: string) => void
  ): Promise<string> {
    const apiMessages: Array<{ role: string; content: unknown }> = [
      { role: "system", content: systemPrompt },
    ];
    for (const m of messages) {
      if (typeof m.content === "string") {
        apiMessages.push({ role: m.role, content: m.content });
        continue;
      }
      const text = getText(m.content);
      const images = getImageParts(m.content);
      const documents = getDocumentParts(m.content);
      if (documents.length > 0) {
        // PDFs are not supported by OpenAI-compatible chat completions;
        // silently drop rather than logging (rule 21).
      }
      const parts: Array<Record<string, unknown>> = [];
      if (text) parts.push({ type: "text", text });
      const loaded = await Promise.all(images.map(p => loadBinaryPart(this.app, p)));
      for (const img of loaded) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        });
      }
      apiMessages.push({ role: m.role, content: parts });
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        messages: apiMessages,
      }),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message
        ?? `API error ${response.status}: ${(response.text ?? "").slice(0, 200)}`;
      throw new Error(message);
    }

    const choices = response.json?.choices as
      | Array<{ message?: { content?: string } }>
      | undefined;
    const full = choices?.[0]?.message?.content ?? "";

    if (full.length === 0) {
      throw new Error("No text content in response");
    }
    onToken?.(full);
    return full;
  }

  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/models`,
      method: "GET",
      headers,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = response.json?.data as Array<{ id: string }> | undefined;
    return (data ?? []).map(m => m.id).sort();
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
