import type { App, TFile } from "obsidian";

export interface WikiLinkToken {
  type: "text" | "wikilink" | "context-ref" | "image-ref";
  text: string;
  notePath: string | null;
}

export class NoteSuggest {
  private app: App;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private popupEl: HTMLElement | null = null;
  private items: TFile[] = [];
  private selectedIndex = 0;
  private triggerStart = -1;
  private hasAtPrefix = false;
  private onImagePicked: ((file: TFile) => void) | null = null;

  private boundOnInput: () => void;
  private boundOnKeydown: (e: KeyboardEvent) => void;
  private boundOnBlur: () => void;

  constructor(
    app: App,
    inputEl: HTMLTextAreaElement | HTMLInputElement,
    onImagePicked?: (file: TFile) => void,
  ) {
    this.app = app;
    this.inputEl = inputEl;
    this.onImagePicked = onImagePicked ?? null;

    this.boundOnInput = this.onInput.bind(this);
    this.boundOnKeydown = this.onKeydown.bind(this);
    this.boundOnBlur = this.onBlur.bind(this);

    this.inputEl.addEventListener("input", this.boundOnInput);
    this.inputEl.addEventListener("keydown", this.boundOnKeydown as EventListener, true);
    this.inputEl.addEventListener("blur", this.boundOnBlur);
  }

  destroy(): void {
    this.inputEl.removeEventListener("input", this.boundOnInput);
    this.inputEl.removeEventListener("keydown", this.boundOnKeydown as EventListener, true);
    this.inputEl.removeEventListener("blur", this.boundOnBlur);
    this.dismissPopup();
  }

  private onInput(): void {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;

    // Look backwards from cursor for [[ trigger
    const before = value.slice(0, cursor);
    const triggerIdx = before.lastIndexOf("[[");

    if (triggerIdx === -1 || before.indexOf("]]", triggerIdx) !== -1) {
      this.dismissPopup();
      return;
    }

    // Check if there's a closing ]] after cursor already — if so, we're inside a completed link
    const after = value.slice(cursor);
    if (after.startsWith("]]")) {
      this.dismissPopup();
      return;
    }

    this.triggerStart = triggerIdx;
    this.hasAtPrefix = triggerIdx > 0 && value[triggerIdx - 1] === "@";
    const query = before.slice(triggerIdx + 2);

    this.updateResults(query);
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.popupEl) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
      this.highlightSelected();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.highlightSelected();
    } else if (e.key === "Enter" && this.items.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.confirmSelection(this.items[this.selectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.dismissPopup();
    }
  }

  private onBlur(): void {
    // Delay to allow click on popup item to fire first
    activeWindow.setTimeout(() => this.dismissPopup(), 150);
  }

  private updateResults(query: string): void {
    const exts = new Set(["md", "png", "jpg", "jpeg", "gif", "webp"]);
    const files = this.app.vault.getFiles().filter(f => exts.has(f.extension.toLowerCase()));
    const lowerQuery = query.toLowerCase();

    this.items = files
      .filter(f => f.basename.toLowerCase().includes(lowerQuery))
      .sort((a, b) => {
        const aName = a.basename.toLowerCase();
        const bName = b.basename.toLowerCase();
        // Prefer starts-with matches
        const aStarts = aName.startsWith(lowerQuery) ? 0 : 1;
        const bStarts = bName.startsWith(lowerQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return aName.localeCompare(bName);
      })
      .slice(0, 10);

    this.selectedIndex = 0;

    if (this.items.length === 0) {
      this.dismissPopup();
      return;
    }

    this.showPopup();
  }

  private showPopup(): void {
    if (!this.popupEl) {
      const parent = this.inputEl.parentElement;
      if (!parent) return;
      this.popupEl = parent.createDiv({ cls: "annotator-suggest-popup" });
    }

    this.popupEl.empty();

    for (let i = 0; i < this.items.length; i++) {
      const file = this.items[i];
      const item = this.popupEl.createDiv({ cls: "annotator-suggest-item" });
      item.createSpan({ cls: "annotator-suggest-name", text: file.basename });

      const ext = file.extension.toLowerCase();
      if (ext !== "md") {
        item.createSpan({
          cls: "annotator-suggest-badge",
          text: ext.toUpperCase(),
        });
      }

      // Show folder path if not root
      if (file.parent && file.parent.path !== "/") {
        item.createSpan({ cls: "annotator-suggest-path", text: file.parent.path });
      }

      if (i === this.selectedIndex) {
        item.addClass("is-selected");
      }

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        this.confirmSelection(file);
      });
    }
  }

  private highlightSelected(): void {
    if (!this.popupEl) return;
    const children = this.popupEl.children;
    for (let i = 0; i < children.length; i++) {
      children[i].toggleClass("is-selected", i === this.selectedIndex);
    }
  }

  private confirmSelection(file: TFile): void {
    const value = this.inputEl.value;
    const insertStart = this.hasAtPrefix ? this.triggerStart - 1 : this.triggerStart;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const prefix = this.hasAtPrefix ? "@" : "";

    const replacement = `${prefix}[[${file.basename}]]`;
    const newValue = value.slice(0, insertStart) + replacement + value.slice(cursor);

    this.inputEl.value = newValue;
    const newCursor = insertStart + replacement.length;
    this.inputEl.setSelectionRange(newCursor, newCursor);
    this.inputEl.focus();

    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
    if (imageExts.has(file.extension.toLowerCase()) && this.onImagePicked) {
      this.onImagePicked(file);
    }

    this.dismissPopup();
    // Fire input event so any other listeners stay in sync
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private dismissPopup(): void {
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    this.items = [];
    this.selectedIndex = 0;
    this.triggerStart = -1;
  }

  /** Parse wiki-links and context refs from message content */
  static parseWikiLinks(content: string, app: App): WikiLinkToken[] {
    const tokens: WikiLinkToken[] = [];
    // Match @[[...]] and [[...]] patterns
    const pattern = /(@?\[\[([^\]]+)\]\])/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: "text", text: content.slice(lastIndex, match.index), notePath: null });
      }

      const fullMatch = match[1];
      const noteName = match[2];
      const isContext = fullMatch.startsWith("@");
      const resolved = app.metadataCache.getFirstLinkpathDest(noteName, "");

      const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
      const isImage = !!resolved && imageExts.has(resolved.extension.toLowerCase());
      tokens.push({
        type: isImage ? "image-ref" : (isContext ? "context-ref" : "wikilink"),
        text: noteName,
        notePath: resolved?.path ?? null,
      });

      lastIndex = match.index + fullMatch.length;
    }

    if (lastIndex < content.length) {
      tokens.push({ type: "text", text: content.slice(lastIndex), notePath: null });
    }

    return tokens;
  }
}
