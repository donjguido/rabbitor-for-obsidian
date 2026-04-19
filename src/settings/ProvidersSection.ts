import { Setting, FuzzySuggestModal, Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { ProviderConfig } from "../types";
import type { AIProvider } from "../ai/AIProvider";
import {
  getCachedModels,
  setCachedModels,
  isCacheStale,
  clearCache,
} from "../ai/modelCache";

const PROVIDER_TYPES = [
  { type: "anthropic", label: "Anthropic (Claude)" },
  { type: "openai", label: "OpenAI" },
  { type: "gemini", label: "Google Gemini" },
  { type: "openrouter", label: "OpenRouter" },
  { type: "ollama", label: "Ollama (local)" },
  { type: "custom", label: "Custom (OpenAI-compatible)" },
] as const;

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  openrouter: "anthropic/claude-sonnet-4",
  ollama: "llama3.2",
  custom: "",
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class ProvidersSection {
  private containerEl: HTMLElement;
  private plugin: AnnotatorPlugin;
  private editingProviderId: string | null = null;

  constructor(containerEl: HTMLElement, plugin: AnnotatorPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
  }

  display(): void {
    if (this.editingProviderId) {
      const config = this.plugin.settings.providers.find(
        (p) => p.id === this.editingProviderId
      );
      if (config) {
        this.renderEditView(config);
        return;
      }
      this.editingProviderId = null;
    }
    this.renderListView();
  }

  private renderListView(): void {
    const { containerEl } = this;

    if (this.plugin.settings.providers.length === 0) {
      containerEl.createEl("p", {
        text: "No AI providers configured. Add one to start chatting.",
        cls: "setting-item-description",
      });
    }

    for (const config of this.plugin.settings.providers) {
      const isActive = config.id === this.plugin.settings.activeProviderId;
      const typeLabel =
        PROVIDER_TYPES.find((t) => t.type === config.type)?.label || config.type;

      const setting = new Setting(containerEl)
        .setName(config.name || "Unnamed provider")
        .setDesc(`${typeLabel} \u00B7 ${config.model || "no model"}`);

      if (isActive) {
        setting.nameEl.createSpan({
          text: " (active)",
          cls: "annotator-provider-active-badge",
        });
      }

      setting.addButton((btn) => {
        btn.setButtonText("Edit");
        btn.onClick(() => {
          this.editingProviderId = config.id;
          containerEl.empty();
          this.display();
        });
      });

      if (!isActive) {
        setting.addButton((btn) => {
          btn.setButtonText("Set active");
          btn.onClick(async () => {
            this.plugin.settings.activeProviderId = config.id;
            await this.plugin.saveSettings();
            containerEl.empty();
            this.display();
          });
        });
      }
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText("Add provider");
      btn.setCta();
      btn.onClick(() => {
        new ProviderTypePicker(this.plugin.app, async (type) => {
          const config: ProviderConfig = {
            id: generateId(),
            type: type as ProviderConfig["type"],
            name: PROVIDER_TYPES.find((t) => t.type === type)?.label || type,
            apiKey: "",
            baseUrl: DEFAULT_BASE_URLS[type] || "",
            model: DEFAULT_MODELS[type] || "",
            maxTokens: 4096,
            temperature: 0.7,
          };
          this.plugin.settings.providers.push(config);
          if (!this.plugin.settings.activeProviderId) {
            this.plugin.settings.activeProviderId = config.id;
          }
          await this.plugin.saveSettings();
          this.editingProviderId = config.id;
          containerEl.empty();
          this.display();
        }).open();
      });
    });
  }

  private renderEditView(config: ProviderConfig): void {
    const { containerEl } = this;

    // Back button
    const header = containerEl.createDiv({ cls: "annotator-provider-edit-header" });
    const backBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(backBtn, "arrow-left");
    backBtn.addEventListener("click", () => {
      this.editingProviderId = null;
      containerEl.empty();
      this.display();
    });
    header.createSpan({ text: config.name || "Edit provider" });

    // Nickname
    new Setting(containerEl)
      .setName("Nickname")
      .addText((text) => {
        text.setValue(config.name);
        text.onChange(async (value) => {
          config.name = value;
          await this.plugin.saveSettings();
        });
      });

    // Type (read-only)
    const typeLabel =
      PROVIDER_TYPES.find((t) => t.type === config.type)?.label || config.type;
    new Setting(containerEl)
      .setName("Type")
      .setDesc(typeLabel);

    // API key (skip for ollama)
    if (config.type !== "ollama") {
      new Setting(containerEl)
        .setName("API key")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.style.width = "250px";
          text.setValue(config.apiKey || "");
          text.setPlaceholder(config.type === "anthropic" ? "sk-ant-..." : "sk-...");
          text.onChange(async (value) => {
            config.apiKey = value;
            await this.plugin.saveSettings();
            // Invalidate model cache on key change
            const data = (await this.plugin.loadData()) || {};
            clearCache(data, config.id);
            await this.plugin.saveData(data);
          });
        });
    }

    // Base URL (shown for ollama, custom, openrouter; hidden for anthropic)
    if (config.type !== "anthropic" && config.type !== "openai" && config.type !== "gemini") {
      new Setting(containerEl)
        .setName("Base URL")
        .addText((text) => {
          text.inputEl.style.width = "300px";
          text.setValue(config.baseUrl || "");
          text.setPlaceholder(DEFAULT_BASE_URLS[config.type] || "https://...");
          text.onChange(async (value) => {
            config.baseUrl = value;
            await this.plugin.saveSettings();
            // Invalidate model cache on URL change
            const data = (await this.plugin.loadData()) || {};
            clearCache(data, config.id);
            await this.plugin.saveData(data);
          });
        });
    }

    // Model
    this.renderModelField(containerEl, config);

    // Max tokens
    new Setting(containerEl)
      .setName("Max tokens")
      .setDesc("Maximum number of tokens in AI responses.")
      .addSlider((slider) => {
        slider
          .setLimits(256, 32768, 256)
          .setValue(config.maxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            config.maxTokens = value;
            await this.plugin.saveSettings();
          });
      });

    // Temperature
    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Controls randomness. Lower = more focused, higher = more creative.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 2, 0.1)
          .setValue(config.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            config.temperature = value;
            await this.plugin.saveSettings();
          });
      });

    // Test connection
    new Setting(containerEl)
      .addButton((btn) => {
        btn.setButtonText("Test connection");
        btn.onClick(async () => {
          const provider = this.plugin.providerManager.getProvider(config.id);
          if (!provider) {
            btn.setButtonText("\u2717 Provider not found");
            setTimeout(() => btn.setButtonText("Test connection"), 3000);
            return;
          }
          btn.setButtonText("Testing...");
          btn.setDisabled(true);
          const valid = await provider.validateConfig();
          btn.setDisabled(false);
          btn.setButtonText(valid ? "\u2713 Connected" : "\u2717 Failed");
          setTimeout(() => btn.setButtonText("Test connection"), 3000);
        });
      });

    // Delete
    new Setting(containerEl)
      .addButton((btn) => {
        btn.setButtonText("Delete provider");
        btn.setWarning();
        btn.onClick(() => {
          new ConfirmDeleteModal(this.plugin.app, config.name, async () => {
            this.plugin.settings.providers = this.plugin.settings.providers.filter(
              (p) => p.id !== config.id
            );
            if (this.plugin.settings.activeProviderId === config.id) {
              this.plugin.settings.activeProviderId =
                this.plugin.settings.providers[0]?.id || "";
            }
            await this.plugin.saveSettings();
            this.editingProviderId = null;
            containerEl.empty();
            this.display();
          }).open();
        });
      });
  }

  private async renderModelField(
    containerEl: HTMLElement,
    config: ProviderConfig
  ): Promise<void> {
    const modelSetting = new Setting(containerEl).setName("Model");

    // Try to load cached models
    const pluginData = (await this.plugin.loadData()) || {};
    const cached = getCachedModels(pluginData, config.id);
    const stale = isCacheStale(pluginData, config.id);

    if (cached && !stale) {
      // Use cached models
      this.addModelDropdown(modelSetting, config, cached);
    } else {
      // Try fetching
      const provider = this.plugin.providerManager.getProvider(config.id);
      if (provider && (config.apiKey || config.type === "ollama")) {
        modelSetting.setDesc("Fetching models...");
        this.fetchAndShowModels(modelSetting, config, provider);
      } else {
        // No API key yet — show freeform
        this.addModelFreeform(modelSetting, config);
      }
    }

    // Refresh button
    modelSetting.addButton((btn) => {
      btn.setIcon("refresh-cw");
      btn.setTooltip("Refresh model list");
      btn.onClick(async () => {
        const data = (await this.plugin.loadData()) || {};
        clearCache(data, config.id);
        await this.plugin.saveData(data);
        containerEl.empty();
        this.display();
      });
    });
  }

  private async fetchAndShowModels(
    setting: Setting,
    config: ProviderConfig,
    provider: AIProvider
  ): Promise<void> {
    try {
      const models = await provider.listModels();
      // Cache them
      const data = (await this.plugin.loadData()) || {};
      setCachedModels(data, config.id, models);
      await this.plugin.saveData(data);

      setting.setDesc("");
      this.addModelDropdown(setting, config, models);
    } catch {
      setting.setDesc("Couldn't fetch models");
      this.addModelFreeform(setting, config);
    }
  }

  private addModelDropdown(
    setting: Setting,
    config: ProviderConfig,
    models: string[]
  ): void {
    setting.addDropdown((dropdown) => {
      for (const model of models) {
        dropdown.addOption(model, model);
      }
      // Ensure current model is in the list
      if (config.model && !models.includes(config.model)) {
        dropdown.addOption(config.model, `${config.model} (current)`);
      }
      dropdown.setValue(config.model);
      dropdown.onChange(async (value) => {
        config.model = value;
        await this.plugin.saveSettings();
      });
    });
  }

  private addModelFreeform(setting: Setting, config: ProviderConfig): void {
    setting.addText((text) => {
      text.setValue(config.model);
      text.setPlaceholder("Model ID");
      text.onChange(async (value) => {
        config.model = value;
        await this.plugin.saveSettings();
      });
    });
  }
}

class ProviderTypePicker extends FuzzySuggestModal<string> {
  private onChoose: (type: string) => void;

  constructor(app: App, onChoose: (type: string) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose provider type");
  }

  getItems(): string[] {
    return PROVIDER_TYPES.map((t) => t.type);
  }

  getItemText(item: string): string {
    return PROVIDER_TYPES.find((t) => t.type === item)?.label || item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}

class ConfirmDeleteModal extends Modal {
  private name: string;
  private onConfirm: () => void;

  constructor(app: App, name: string, onConfirm: () => void) {
    super(app);
    this.name = name;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Delete provider?");
    contentEl.createEl("p", {
      text: `Are you sure you want to delete "${this.name}"? This cannot be undone.`,
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = buttonRow.createEl("button", { text: "Delete" });
    confirmBtn.addClass("mod-warning");
    confirmBtn.addEventListener("click", () => {
      this.onConfirm();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
