import type { AIProvider } from "./AIProvider";
import type { ProviderConfig, MessageContent } from "../types";
import { getText, getImageParts, getDocumentParts } from "./messageContent";
import { loadBinaryPart } from "./multimodal";

interface SSEEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

export class AnthropicProvider implements AIProvider {
  readonly type = "anthropic";
  readonly displayName = "Anthropic (Claude)";
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
    const apiMessages = await Promise.all(
      messages.map(async (m) => {
        if (typeof m.content === "string") {
          return { role: m.role, content: m.content };
        }
        const text = getText(m.content);
        const images = getImageParts(m.content);
        const documents = getDocumentParts(m.content);
        const blocks: Array<Record<string, unknown>> = [];
        if (text) blocks.push({ type: "text", text });
        const loadedImages = await Promise.all(images.map(p => loadBinaryPart(this.app, p)));
        for (const img of loadedImages) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.base64 },
          });
        }
        const loadedDocs = await Promise.all(documents.map(p => loadBinaryPart(this.app, p)));
        for (const doc of loadedDocs) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: doc.mimeType, data: doc.base64 },
          });
        }
        return { role: m.role, content: blocks };
      })
    );

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey || "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        system: systemPrompt,
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
      throw new Error("No response body from Anthropic stream");
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
          let event: SSEEvent;
          try {
            event = JSON.parse(payload) as SSEEvent;
          } catch {
            continue;
          }
          if (event.type === "error") {
            throw new Error(event.error?.message || "Stream error");
          }
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            const chunk = event.delta.text ?? "";
            if (chunk) {
              full += chunk;
              onToken?.(chunk);
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be closed; safe to ignore.
      }
    }

    if (full.length === 0) {
      throw new Error("No text content in streamed response");
    }
    return full;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": this.config.apiKey || "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
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
