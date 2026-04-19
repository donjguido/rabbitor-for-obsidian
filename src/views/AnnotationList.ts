import { setIcon } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { Annotation } from "../types";

export class AnnotationList {
  private containerEl: HTMLElement;
  private plugin: AnnotatorPlugin;
  private onSelect: (ann: Annotation) => void;
  private onDoubleClick: (ann: Annotation) => void;
  private selectedId: string | null = null;

  constructor(
    containerEl: HTMLElement,
    plugin: AnnotatorPlugin,
    onSelect: (ann: Annotation) => void,
    onDoubleClick: (ann: Annotation) => void
  ) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.onSelect = onSelect;
    this.onDoubleClick = onDoubleClick;
  }

  render(): void {
    this.containerEl.empty();
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      const empty = this.containerEl.createDiv({ cls: "annotator-empty" });
      empty.createSpan({ text: "Open a markdown file to see annotations." });
      return;
    }

    const annotations = this.plugin.store.getForFile(activeFile.path);
    if (annotations.length === 0) {
      const empty = this.containerEl.createDiv({ cls: "annotator-empty" });
      empty.createSpan({ text: "No annotations yet. Select text to annotate." });
      return;
    }

    const sorted = [...annotations].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const list = this.containerEl.createDiv({ cls: "annotator-list" });
    for (const ann of sorted) {
      this.renderCard(list, ann);
    }
  }

  private renderCard(container: HTMLElement, ann: Annotation): void {
    const num = this.plugin.store.getAnnotationNumber(ann);
    const card = container.createDiv({
      cls: `annotator-card ${this.selectedId === ann.id ? "selected" : ""}`,
    });
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Annotation ${num}: ${ann.label || ann.excerpt.slice(0, 40)}`);
    card.dataset.annotationId = ann.id;

    // Header row: color dot + label + number
    const header = card.createDiv({ cls: "annotator-card-header" });
    const dot = header.createSpan({ cls: `annotator-dot annotator-dot-${ann.color}` });
    const label = header.createSpan({
      cls: "annotator-card-label",
      text: ann.label || "Untitled",
    });
    // Slow click to rename: click on label when card is already selected
    label.addEventListener("click", (e) => {
      if (this.selectedId === ann.id) {
        e.stopPropagation();
        this.startRename(label, ann);
      }
    });
    header.createSpan({
      cls: "annotator-card-num",
      text: `#${num}`,
    });

    // Excerpt
    const excerptText = ann.excerpt.length > 120
      ? ann.excerpt.slice(0, 120) + "\u2026"
      : ann.excerpt;
    card.createDiv({
      cls: "annotator-card-excerpt",
      text: `\u201C${excerptText}\u201D`,
    });

    // Thread summary
    const msgCount = ann.thread.messages.length;
    const hasBranches = ann.thread.branches.length > 0;
    if (msgCount > 0) {
      const summary = card.createDiv({ cls: "annotator-card-summary" });
      const iconEl = summary.createSpan({ cls: "annotator-card-summary-icon" });
      setIcon(iconEl, "message-circle");
      summary.createSpan({
        text: `${msgCount} message${msgCount !== 1 ? "s" : ""}${hasBranches ? " \u00b7 branched" : ""}`,
      });
    }

    // Delete button
    const deleteBtn = card.createEl("button", {
      cls: "annotator-card-delete clickable-icon",
      attr: {
        "aria-label": `Delete annotation ${num}`,
        "data-tooltip-position": "top",
      },
    });
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.store.deleteAnnotation(ann.id);
    });

    const selectHandler = () => {
      this.selectedId = ann.id;
      container.querySelectorAll(".annotator-card").forEach(c =>
        c.toggleClass("selected", (c as HTMLElement).dataset.annotationId === ann.id)
      );
      this.onSelect(ann);
    };
    card.addEventListener("click", selectHandler);
    card.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.selectedId = ann.id;
      this.onDoubleClick(ann);
    });
    card.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectHandler();
      }
    });
  }

  private startRename(labelEl: HTMLElement, ann: Annotation): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = ann.label;
    input.placeholder = "Untitled";
    input.className = "annotator-rename-input";
    input.setAttribute("aria-label", "Rename annotation");

    const commit = () => {
      const newLabel = input.value.trim();
      if (newLabel !== ann.label) {
        this.plugin.store.updateAnnotation(ann.id, { label: newLabel });
      }
      // Replace input back with span
      labelEl.textContent = newLabel || "Untitled";
      labelEl.style.display = "";
      input.remove();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        labelEl.textContent = ann.label || "Untitled";
        labelEl.style.display = "";
        input.remove();
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());

    labelEl.style.display = "none";
    labelEl.parentElement?.insertBefore(input, labelEl);
    input.focus();
    input.select();
  }
}
