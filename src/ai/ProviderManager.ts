import type { App } from "obsidian";
import type { AIProvider } from "./AIProvider";
import type { ProviderConfig } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { GeminiProvider } from "./GeminiProvider";

export class ProviderManager {
  private providers: Map<string, AIProvider> = new Map();
  private activeId: string;
  private app: App;

  constructor(app: App, configs: ProviderConfig[], activeId: string) {
    this.app = app;
    this.activeId = activeId;
    this.rebuild(configs, activeId);
  }

  rebuild(configs: ProviderConfig[], activeId: string): void {
    this.providers.clear();
    this.activeId = activeId;
    for (const config of configs) {
      const provider = this.createProvider(config);
      if (provider) {
        this.providers.set(config.id, provider);
      }
    }
  }

  getActiveProvider(): AIProvider | null {
    return this.providers.get(this.activeId) || null;
  }

  getProvider(id: string): AIProvider | null {
    return this.providers.get(id) || null;
  }

  private createProvider(config: ProviderConfig): AIProvider | null {
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config, this.app);
      case "openai":
      case "openrouter":
      case "ollama":
      case "custom":
        return new OpenAICompatibleProvider(config, this.app);
      case "gemini":
        return new GeminiProvider(config, this.app);
      default:
        return null;
    }
  }
}
