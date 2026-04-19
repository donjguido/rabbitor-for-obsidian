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
    signal?: AbortSignal,
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
        console.warn(
          `[annotator] OpenAI-compatible provider does not support PDF documents; dropping ${documents.length} part(s).`
        );
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
        stream: true,
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
      throw new Error("No response body from stream");
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
          if (payload === "[DONE]") break;
          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const chunk = event?.choices?.[0]?.delta?.content;
          if (chunk) {
            full += chunk;
            onToken?.(chunk);
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
      throw new Error("No text content in streamed response");
    }
    return full;
  }

  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/models`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const body = await response.json();
    const models: string[] = (body.data || [])
      .map((m: { id: string }) => m.id)
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
