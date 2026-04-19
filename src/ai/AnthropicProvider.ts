import { requestUrl } from "obsidian";
import type { AIProvider } from "./AIProvider";
import type { ProviderConfig, MessageContent } from "../types";
import { getText, getImageParts, getDocumentParts } from "./messageContent";
import { loadBinaryPart } from "./multimodal";

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
    _signal?: AbortSignal,
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

    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
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
      }),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message
        ?? `API error ${response.status}: ${(response.text ?? "").slice(0, 200)}`;
      throw new Error(message);
    }

    const blocks = response.json?.content as Array<{ type: string; text?: string }> | undefined;
    const full = (blocks ?? [])
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text as string)
      .join("");

    if (full.length === 0) {
      throw new Error("No text content in response");
    }
    onToken?.(full);
    return full;
  }

  async listModels(): Promise<string[]> {
    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/models",
      method: "GET",
      headers: {
        "x-api-key": this.config.apiKey || "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
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
