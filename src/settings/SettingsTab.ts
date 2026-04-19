import { App, PluginSettingTab, Setting } from "obsidian";
import type AnnotatorPlugin from "../main";
import { HIGHLIGHT_COLORS } from "../constants";
import { ProvidersSection } from "./ProvidersSection";

export class AnnotatorSettingsTab extends PluginSettingTab {
  plugin: AnnotatorPlugin;

  constructor(app: App, plugin: AnnotatorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Highlights").setHeading();

    new Setting(containerEl)
      .setName("Default color")
      .setDesc("Color used when creating annotations without picking a color.")
      .addDropdown((dropdown) => {
        for (const color of HIGHLIGHT_COLORS) {
          dropdown.addOption(color, color.charAt(0).toUpperCase() + color.slice(1));
        }
        dropdown.setValue(this.plugin.settings.defaultColor);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultColor = value as typeof this.plugin.settings.defaultColor;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show color picker on selection")
      .setDesc("Show a color picker tooltip when selecting text. When off, use the annotate command to highlight with the default color.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showColorPicker);
        toggle.onChange(async (value) => {
          this.plugin.settings.showColorPicker = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Open chat after annotating")
      .setDesc("Automatically open the sidebar chat tab when creating a new annotation.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.openChatAfterAnnotation);
        toggle.onChange(async (value) => {
          this.plugin.settings.openChatAfterAnnotation = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show badge numbers")
      .setDesc("Display numbered badges at the end of each highlight.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showBadges);
        toggle.onChange(async (value) => {
          this.plugin.settings.showBadges = value;
          await this.plugin.saveSettings();
          this.plugin.refreshHighlights();
        });
      });

    new Setting(containerEl).setName("Export").setHeading();

    new Setting(containerEl)
      .setName("Include AI threads")
      .setDesc("Include conversation threads when exporting annotations.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.exportIncludeThreads);
        toggle.onChange(async (value) => {
          this.plugin.settings.exportIncludeThreads = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Include branches")
      .setDesc("Include conversation branches when exporting annotations.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.exportIncludeBranches);
        toggle.onChange(async (value) => {
          this.plugin.settings.exportIncludeBranches = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("AI providers").setHeading();

    new Setting(containerEl)
      .setDesc("API keys are stored in your vault's plugin data file and are not encrypted.");

    new Setting(containerEl)
      .setName("Assistant display name")
      .setDesc("Label used for AI messages in the chat (e.g., Claude, ChatGPT).")
      .addText((text) => {
        text.setPlaceholder("Claude");
        text.setValue(this.plugin.settings.aiDisplayName);
        text.onChange(async (value) => {
          this.plugin.settings.aiDisplayName = value.trim() || "Claude";
          await this.plugin.saveSettings();
        });
      });

    // Delegate provider list + edit to ProvidersSection
    const providersContainer = containerEl.createDiv();
    new ProvidersSection(providersContainer, this.plugin).display();

    new Setting(containerEl).setName("Data").setHeading();

    new Setting(containerEl)
      .setName("Clear all annotations")
      .setDesc("Remove all annotations from the vault. This cannot be undone.")
      .addButton((button) => {
        button.setButtonText("Clear all");
        button.setWarning();
        button.onClick(async () => {
          if (button.buttonEl.textContent === "Confirm clear") {
            await this.plugin.saveData({ annotations: [], version: 1 });
            await this.plugin.store.load();
            this.plugin.refreshHighlights();
            this.plugin.getAnnotatorView()?.refresh();
            button.setButtonText("Clear all");
          } else {
            button.setButtonText("Confirm clear");
            setTimeout(() => button.setButtonText("Clear all"), 3000);
          }
        });
      });
  }
}
