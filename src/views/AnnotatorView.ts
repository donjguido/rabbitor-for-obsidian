import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { Annotation } from "../types";
import { VIEW_TYPE_ANNOTATOR } from "../constants";
import { AnnotationList } from "./AnnotationList";
import { ChatThread } from "./ChatThread";

export { VIEW_TYPE_ANNOTATOR };

type TabId = "annotations" | "chat" | "export";

export class AnnotatorView extends ItemView {
  private plugin: AnnotatorPlugin;
  private activeTab: TabId = "annotations";
  private contentEl_: HTMLElement | null = null;
  private annotationList: AnnotationList | null = null;
  private chatThread: ChatThread | null = null;
  selectedAnnotation: Annotation | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AnnotatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_ANNOTATOR;
  }

  getDisplayText(): string {
    return "Annotator";
  }

  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("annotator-panel");
    this.renderTabs(container);
    this.contentEl_ = container.createDiv({ cls: "annotator-content" });
    this.renderContent();
  }

  async onClose(): Promise<void> {
    this.chatThread?.destroy();
    this.annotationList = null;
    this.chatThread = null;
  }

  private renderTabs(container: HTMLElement): void {
    const tabBar = container.createDiv({ cls: "annotator-tabs" });
    const tabs: Array<{ id: TabId; label: string; icon: string }> = [
      { id: "annotations", label: "Annotations", icon: "list" },
      { id: "chat", label: "Chat", icon: "message-circle" },
      { id: "export", label: "Export", icon: "download" },
    ];

    for (const tab of tabs) {
      const tabEl = tabBar.createDiv({
        cls: `annotator-tab ${this.activeTab === tab.id ? "active" : ""}`,
      });
      tabEl.setAttribute("role", "tab");
      tabEl.setAttribute("tabindex", "0");
      tabEl.setAttribute("aria-label", tab.label);
      tabEl.setAttribute("aria-selected", this.activeTab === tab.id ? "true" : "false");

      const iconSpan = tabEl.createSpan({ cls: "annotator-tab-icon" });
      setIcon(iconSpan, tab.icon);
      tabEl.createSpan({ text: tab.label });

      tabEl.addEventListener("click", () => this.switchTab(tab.id));
      tabEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.switchTab(tab.id);
        }
      });
    }
  }

  private switchTab(tabId: TabId): void {
    this.activeTab = tabId;
    // Update tab active states
    const tabs = this.containerEl.querySelectorAll(".annotator-tab");
    tabs.forEach((tab, i) => {
      const ids: TabId[] = ["annotations", "chat", "export"];
      tab.toggleClass("active", ids[i] === tabId);
      tab.setAttribute("aria-selected", ids[i] === tabId ? "true" : "false");
    });
    this.renderContent();
  }

  private renderContent(): void {
    if (!this.contentEl_) return;
    this.contentEl_.empty();
    this.chatThread?.destroy();
    this.annotationList = null;
    this.chatThread = null;

    switch (this.activeTab) {
      case "annotations":
        this.renderAnnotationsTab();
        break;
      case "chat":
        this.renderChatTab();
        break;
      case "export":
        this.renderExportTab();
        break;
    }
  }

  private renderAnnotationsTab(): void {
    if (!this.contentEl_) return;
    this.annotationList = new AnnotationList(
      this.contentEl_,
      this.plugin,
      (ann: Annotation) => this.onAnnotationSelect(ann),
      (ann: Annotation) => this.onAnnotationDoubleClick(ann)
    );
    this.annotationList.render();
  }

  private renderChatTab(): void {
    if (!this.contentEl_) return;
    if (!this.selectedAnnotation) {
      const empty = this.contentEl_.createDiv({ cls: "annotator-empty" });
      empty.createSpan({ text: "Select an annotation to start chatting." });
      return;
    }
    this.chatThread = new ChatThread(this.contentEl_, this.plugin, this.selectedAnnotation);
    this.chatThread.render();
  }

  private renderExportTab(): void {
    if (!this.contentEl_) return;
    const container = this.contentEl_;

    const exportOptions = [
      { label: "Export as JSON", description: "Full structured data with annotations and threads", icon: "file-json", format: "json" as const },
      { label: "Export as markdown", description: "Formatted note with excerpts and threads", icon: "file-text", format: "markdown" as const },
      { label: "Copy annotation links", description: "Copy Obsidian wikilinks to clipboard", icon: "link", format: "wikilinks" as const },
    ];

    for (const opt of exportOptions) {
      const card = container.createDiv({ cls: "annotator-export-card" });
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", opt.label);

      const iconEl = card.createSpan({ cls: "annotator-export-icon" });
      setIcon(iconEl, opt.icon);

      const textEl = card.createDiv({ cls: "annotator-export-text" });
      textEl.createDiv({ cls: "annotator-export-label", text: opt.label });
      textEl.createDiv({ cls: "annotator-export-desc", text: opt.description });

      const handler = () => this.plugin.exportAnnotations(opt.format);
      card.addEventListener("click", handler);
      card.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handler();
        }
      });
    }
  }

  private onAnnotationSelect(annotation: Annotation): void {
    this.selectedAnnotation = annotation;
    this.plugin.scrollToAnnotation(annotation);
  }

  private onAnnotationDoubleClick(annotation: Annotation): void {
    this.selectedAnnotation = annotation;
    this.switchTab("chat");
    setTimeout(() => {
      this.chatThread?.focusInput();
    }, 0);
  }

  /** Called by the plugin when annotations change */
  refresh(): void {
    if (this.selectedAnnotation) {
      // Re-fetch in case it was updated
      this.selectedAnnotation = this.plugin.store.getById(this.selectedAnnotation.id) || null;
    }

    // Preserve the chat thread instance when we're on the chat tab and still
    // viewing the same annotation. This keeps input state, loading indicators,
    // in-flight AI requests, and the [[ note-suggest popup alive across
    // store updates (e.g., when addMessage fires).
    if (
      this.activeTab === "chat" &&
      this.chatThread &&
      this.selectedAnnotation &&
      this.chatThread.getAnnotationId() === this.selectedAnnotation.id
    ) {
      this.chatThread.refreshMessages();
      return;
    }

    this.renderContent();
  }

  selectAnnotation(annotation: Annotation): void {
    this.selectedAnnotation = annotation;
    this.switchTab("chat");
    // Focus the input after the DOM has rendered
    setTimeout(() => {
      this.chatThread?.focusInput();
    }, 0);
  }
}
