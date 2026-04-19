import { setIcon, TFile, Notice } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { Annotation, ThreadMessage, ParsedCommand, ThreadBranch, ImagePart, DocumentPart } from "../types";
import { getActivePath, getRegenerateNavState, getForkBranches } from "../store/threadPath";
import { createThreadMessage, parseAnnotationRefs, parseContextNoteRefs } from "../store/ThreadStore";
import { NoteSuggest } from "../editor/NoteSuggest";
import { BUILT_IN_COMMANDS } from "../constants";
import { buildSystemPrompt, NOTE_CONTENT_LIMIT } from "../ai/prompt";
import type { PromptContext } from "../ai/prompt";
import { getText, getImageParts, getDocumentParts, makeContent } from "../ai/messageContent";
import { modelLikelySupportsVision, mimeToExt, extToMime, classifyAttachmentFile, providerSupportsDocuments } from "../ai/multimodal";

type PendingItem =
  | { kind: "image"; part: ImagePart }
  | { kind: "document"; part: DocumentPart }
  | { kind: "context"; vaultPath: string; filename: string };

export class ChatThread {
  private containerEl: HTMLElement;
  private plugin: AnnotatorPlugin;
  private annotation: Annotation;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private inputAreaEl: HTMLElement | null = null;
  private sending = false;
  private noteSuggest: NoteSuggest | null = null;
  private commandSuggestEl: HTMLElement | null = null;
  private abortController: AbortController | null = null;
  private streamingBubbleEl: HTMLElement | null = null;
  private pendingForkRename: string | null = null;
  private pendingAttachments: PendingItem[] = [];
  private attachmentsEl: HTMLElement | null = null;
  private warningEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement, plugin: AnnotatorPlugin, annotation: Annotation) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.annotation = annotation;
  }

  render(): void {
    this.containerEl.empty();
    const num = this.plugin.store.getAnnotationNumber(this.annotation);

    // Header
    const header = this.containerEl.createDiv({ cls: "annotator-chat-header" });
    const dot = header.createSpan({ cls: `annotator-dot annotator-dot-${this.annotation.color}` });
    header.createSpan({
      cls: "annotator-chat-title-prefix",
      text: `#${num}: `,
    });
    const titleEl = header.createSpan({
      cls: "annotator-chat-title",
      text: this.annotation.label || "Untitled",
    });
    titleEl.addEventListener("dblclick", () => this.startRename(titleEl));
    this.renderForkPicker(header);

    // Messages container
    this.messagesEl = this.containerEl.createDiv({ cls: "annotator-chat-messages" });
    this.renderMessages();

    // Input area
    this.commandSuggestEl = null;
    const inputArea = this.containerEl.createDiv({ cls: "annotator-chat-input" });
    this.inputAreaEl = inputArea;

    if (!this.plugin.providerManager.getActiveProvider()) {
      const placeholder = inputArea.createDiv({ cls: "annotator-chat-no-provider" });
      placeholder.setText("Configure an AI provider in settings to start chatting");
      placeholder.style.cursor = "pointer";
      placeholder.style.padding = "12px";
      placeholder.style.textAlign = "center";
      placeholder.style.color = "var(--text-muted)";
      placeholder.style.fontSize = "var(--font-ui-small)";
      placeholder.addEventListener("click", () => {
        (this.plugin.app as any).setting?.open?.();
      });
      return;
    }

    const inputRow = inputArea.createDiv({ cls: "annotator-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "annotator-chat-textarea",
      attr: {
        "aria-label": "Chat message input",
        placeholder: "Ask about this highlight... /",
        rows: "1",
      },
    });

    // Clean up previous suggest if re-rendering
    this.noteSuggest?.destroy();
    this.noteSuggest = new NoteSuggest(this.plugin.app, this.inputEl, (file) => {
      const ext = file.extension.toLowerCase();
      const mime = extToMime(ext);
      if (!mime) return;
      this.pendingAttachments.push({
        kind: "image",
        part: { type: "image", vaultPath: file.path, mimeType: mime },
      });
      this.renderAttachmentChips();
    });

    const sendBtn = inputRow.createEl("button", {
      cls: "annotator-send-btn",
      attr: {
        "aria-label": "Send message",
        "data-tooltip-position": "top",
      },
    });
    setIcon(sendBtn, "arrow-up");

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.abortController) {
        e.preventDefault();
        this.abortController.abort();
        this.abortController = null;
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // If command suggest is open, pick the highlighted item
        if (this.commandSuggestEl && !this.commandSuggestEl.hasClass("annotator-hidden")) {
          const active = this.commandSuggestEl.querySelector(".is-selected") as HTMLElement | null;
          if (active) {
            active.click();
            return;
          }
        }
        this.sendMessage();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (this.commandSuggestEl && !this.commandSuggestEl.hasClass("annotator-hidden")) {
          e.preventDefault();
          this.navigateCommandSuggest(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === "Escape") {
        this.hideCommandSuggest();
      } else if (e.key === "Tab") {
        if (this.commandSuggestEl && !this.commandSuggestEl.hasClass("annotator-hidden")) {
          e.preventDefault();
          const active = this.commandSuggestEl.querySelector(".is-selected") as HTMLElement | null;
          if (active) active.click();
        }
      } else if (e.key === "Backspace") {
        if (
          this.inputEl &&
          this.inputEl.value.length === 0 &&
          this.inputEl.selectionStart === 0 &&
          this.inputEl.selectionEnd === 0 &&
          this.pendingAttachments.length > 0
        ) {
          e.preventDefault();
          this.pendingAttachments.pop();
          this.renderAttachmentChips();
        }
      }
    });

    this.inputEl.addEventListener("input", () => {
      this.autoGrowInput();
      this.onInputChanged();
    });

    this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter(it => /^image\/(png|jpeg|gif|webp)$/.test(it.type));
      if (imageItems.length === 0) return;
      e.preventDefault();
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (blob) void this.attachImageBlob(blob);
      }
    });

    this.inputEl.addEventListener("dragover", (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      if (!types.includes("Files")) return;
      e.preventDefault();
      this.inputEl?.classList.add("is-drop-target");
    });

    this.inputEl.addEventListener("dragleave", () => {
      this.inputEl?.classList.remove("is-drop-target");
    });

    this.inputEl.addEventListener("drop", (e: DragEvent) => {
      this.inputEl?.classList.remove("is-drop-target");
      const files = Array.from(e.dataTransfer?.files ?? []);
      const imageFiles = files.filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
      if (imageFiles.length === 0) return;
      e.preventDefault();
      for (const file of imageFiles) {
        void this.attachImageBlob(file);
      }
    });

    this.attachmentsEl = inputArea.createDiv({
      cls: "annotator-chat-attachments annotator-hidden",
    });
    this.warningEl = inputArea.createDiv({
      cls: "annotator-chat-warning annotator-hidden",
      text: "Current model may not support images.",
    });

    sendBtn.addEventListener("click", () => this.sendMessage());

    // Initial sizing in case of default content
    this.autoGrowInput();
  }

  /** Resize the textarea to fit its content, capped at a max height. */
  private autoGrowInput(): void {
    const el = this.inputEl;
    if (!el) return;
    // Reset height so scrollHeight reflects current content, not previous size
    el.style.height = "auto";
    const maxHeight = 160;
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  /** Called when the underlying annotation changed in the store.
   *  Re-reads the annotation and re-renders only the messages list,
   *  preserving input state, in-flight requests, and note-suggest popup. */
  refreshMessages(): void {
    const updated = this.plugin.store.getById(this.annotation.id);
    if (updated) {
      this.annotation = updated;
    }
    this.renderMessages();
  }

  /** Walk the active path tracking the last branch we switched into.
   *  Returns the branch id whose messages the active path ends in, or
   *  null if the active path is entirely on the main thread. New messages
   *  appended by sendMessage should land in this branch when non-null. */
  private getLeafBranchId(): string | null {
    let seq: ThreadMessage[] = this.annotation.thread.messages;
    let currentBranch: string | null = null;
    let i = 0;
    let safety = 10_000;
    while (i < seq.length && safety-- > 0) {
      const msg = seq[i];
      const activeChildId = this.annotation.thread.activeBranchByParent[msg.id];
      if (activeChildId) {
        const branch = this.annotation.thread.branches.find(b => b.id === activeChildId);
        if (branch) {
          currentBranch = activeChildId;
          seq = branch.messages;
          i = 0;
          continue;
        }
      }
      i++;
    }
    return currentBranch;
  }

  /** Whether this chat thread is still displaying the given annotation id. */
  getAnnotationId(): string {
    return this.annotation.id;
  }

  destroy(): void {
    // NOTE: do not abort in-flight requests on destroy. Per spec, navigate-away
    // must not cancel the AI call — it continues in the background and saves
    // to the store by annotation id. Only Escape (while input focused) aborts.
    this.noteSuggest?.destroy();
    this.noteSuggest = null;
    this.pendingAttachments = [];
  }

  private renderAttachmentChips(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.empty();
    if (this.pendingAttachments.length === 0) {
      this.attachmentsEl.addClass("annotator-hidden");
      this.updateCapabilityWarning();
      return;
    }
    this.attachmentsEl.removeClass("annotator-hidden");

    for (const item of this.pendingAttachments) {
      const chip = this.attachmentsEl.createDiv({ cls: "annotator-chat-attachment-chip" });

      if (item.kind === "image") {
        const part = item.part;
        const file = this.plugin.app.vault.getAbstractFileByPath(part.vaultPath);
        const filename = part.vaultPath.split("/").pop() || part.vaultPath;
        const thumb = chip.createEl("img", {
          cls: "annotator-chat-attachment-thumb",
          attr: { alt: filename },
        });
        if (file instanceof TFile) {
          thumb.src = this.plugin.app.vault.getResourcePath(file);
          thumb.addEventListener("click", () => {
            this.plugin.app.workspace.openLinkText(part.vaultPath, "");
          });
        } else {
          thumb.style.display = "none";
        }
        chip.createSpan({
          cls: "annotator-chat-attachment-label",
          text: filename,
          attr: { title: part.vaultPath },
        });
      } else if (item.kind === "document") {
        chip.addClass("is-document");
        const iconEl = chip.createSpan({ cls: "annotator-chat-attachment-icon" });
        setIcon(iconEl, "file-text");
        iconEl.addEventListener("click", () => {
          this.plugin.app.workspace.openLinkText(item.part.vaultPath, "");
        });
        const filename = item.part.vaultPath.split("/").pop() || item.part.vaultPath;
        chip.createSpan({
          cls: "annotator-chat-attachment-label",
          text: filename,
          attr: { title: item.part.vaultPath },
        });
      } else {
        // context
        chip.addClass("is-context");
        const iconEl = chip.createSpan({ cls: "annotator-chat-attachment-icon" });
        setIcon(iconEl, "file-code");
        iconEl.addEventListener("click", () => {
          this.plugin.app.workspace.openLinkText(item.vaultPath, "");
        });
        chip.createSpan({
          cls: "annotator-chat-attachment-label",
          text: item.filename,
          attr: { title: item.vaultPath },
        });
        chip.createSpan({
          cls: "annotator-chat-attachment-badge",
          text: "context",
        });
      }

      const removeBtn = chip.createEl("button", {
        cls: "annotator-chat-attachment-remove clickable-icon",
        attr: { "aria-label": "Remove attachment" },
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        const idx = this.pendingAttachments.indexOf(item);
        if (idx !== -1) this.pendingAttachments.splice(idx, 1);
        this.renderAttachmentChips();
      });
    }

    this.updateCapabilityWarning();
  }

  private async attachImageBlob(blob: File): Promise<void> {
    const ext = mimeToExt(blob.type);
    const filename = blob.name && blob.name !== "image.png"
      ? blob.name
      : `pasted-image-${Date.now()}.${ext}`;
    const sourcePath = this.annotation.fileVaultPath;
    const targetPath = await this.plugin.app.fileManager
      .getAvailablePathForAttachment(filename, sourcePath);
    const buffer = await blob.arrayBuffer();
    const file = await this.plugin.app.vault.createBinary(targetPath, buffer);
    this.pendingAttachments.push({
      kind: "image",
      part: {
        type: "image",
        vaultPath: file.path,
        mimeType: blob.type as ImagePart["mimeType"],
      },
    });
    this.renderAttachmentChips();
  }

  /** Copy a File (picked from the OS file dialog) into the vault's attachment
   *  folder and return the created TFile. Uses the same
   *  fileManager.getAvailablePathForAttachment path as paste/drop. */
  private async copyOsFileToVault(file: File): Promise<TFile> {
    const sourcePath = this.annotation.fileVaultPath;
    const targetPath = await this.plugin.app.fileManager
      .getAvailablePathForAttachment(file.name, sourcePath);
    const buffer = await file.arrayBuffer();
    return await this.plugin.app.vault.createBinary(targetPath, buffer);
  }

  /** /attach — open the OS file picker and add picked files to pendingAttachments. */
  private async handleAttach(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = [
      ".png", ".jpg", ".jpeg", ".gif", ".webp",
      ".pdf",
      ".txt", ".md", ".markdown",
      ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".log",
      ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
      ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".swift", ".kt",
      ".html", ".htm", ".css", ".scss", ".sass",
      ".sh", ".bash", ".zsh", ".fish",
      ".sql",
    ].join(",");
    input.style.display = "none";

    const picked = await new Promise<File[]>((resolve) => {
      const onFocus = () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) resolve([]);
          window.removeEventListener("focus", onFocus);
        }, 300);
      };
      input.addEventListener("change", () => {
        window.removeEventListener("focus", onFocus);
        resolve(Array.from(input.files ?? []));
      }, { once: true });
      window.addEventListener("focus", onFocus);
      input.click();
    });

    if (picked.length === 0) {
      this.sending = false;
      return;
    }

    for (const f of picked) {
      const kind = classifyAttachmentFile(f.name);
      if (kind === "unknown") {
        new Notice(`Unsupported file type: ${f.name}`);
        continue;
      }
      try {
        const tfile = await this.copyOsFileToVault(f);
        if (kind === "image") {
          const mime = extToMime(tfile.extension);
          if (!mime) {
            new Notice(`Could not determine image type: ${f.name}`);
            continue;
          }
          this.pendingAttachments.push({
            kind: "image",
            part: { type: "image", vaultPath: tfile.path, mimeType: mime },
          });
        } else if (kind === "document") {
          this.pendingAttachments.push({
            kind: "document",
            part: { type: "document", vaultPath: tfile.path, mimeType: "application/pdf" },
          });
        } else if (kind === "text") {
          this.pendingAttachments.push({
            kind: "context",
            vaultPath: tfile.path,
            filename: tfile.name,
          });
        }
      } catch (err) {
        new Notice(`Failed to attach ${f.name}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    this.renderAttachmentChips();
    this.sending = false;
  }

  private updateCapabilityWarning(): void {
    if (!this.warningEl) return;
    const hasImages = this.pendingAttachments.some(p => p.kind === "image");
    const hasDocuments = this.pendingAttachments.some(p => p.kind === "document");
    if (!hasImages && !hasDocuments) {
      this.warningEl.addClass("annotator-hidden");
      return;
    }
    const activeProvider = this.plugin.settings.providers.find(
      p => p.id === this.plugin.settings.activeProviderId
    );
    const model = activeProvider?.model || "";
    const providerType = activeProvider?.type ?? "custom";

    const imageUnsupported = hasImages && !modelLikelySupportsVision(model);
    const documentUnsupported = hasDocuments && !providerSupportsDocuments(providerType);

    if (!imageUnsupported && !documentUnsupported) {
      this.warningEl.addClass("annotator-hidden");
      return;
    }

    const parts: string[] = [];
    if (imageUnsupported) parts.push("Current model may not support images.");
    if (documentUnsupported) parts.push("Current provider does not support PDF attachments — they will be ignored.");
    this.warningEl.setText(parts.join(" "));
    this.warningEl.removeClass("annotator-hidden");
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();

    const path = getActivePath(this.annotation.thread);

    if (path.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "annotator-chat-empty" });
      empty.createSpan({ text: "No messages yet. Ask a question about this highlight." });
      return;
    }

    // Find the latest assistant message in the active path — its fork and
    // regen icons are hidden since a user can use slash commands there.
    let lastAssistantIdx = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    for (let i = 0; i < path.length; i++) {
      this.renderMessage(path[i], i, path, i === lastAssistantIdx);
    }

    // Auto-scroll to bottom
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderForkPicker(header: HTMLElement): void {
    const forks = getForkBranches(this.annotation.thread);
    if (forks.length === 0) return;
    const pickerRow = header.createDiv({ cls: "annotator-fork-picker" });

    const path = getActivePath(this.annotation.thread);
    const activeForkId = this.findActiveForkOnPath(path, forks);

    const select = pickerRow.createEl("select", { cls: "annotator-fork-select" });
    const mainOpt = select.createEl("option", { text: "Main", value: "" });
    if (activeForkId === null) mainOpt.selected = true;
    for (const f of forks) {
      const opt = select.createEl("option", { text: f.label || "Fork", value: f.id });
      if (activeForkId === f.id) opt.selected = true;
    }
    select.addEventListener("change", () => {
      const id = select.value;
      if (id === "") {
        // Clear every fork activation so Main renders.
        for (const f of forks) {
          this.plugin.store.setActiveBranch(this.annotation.id, f.parentMessageId, null);
        }
      } else {
        const chosen = forks.find(f => f.id === id);
        if (chosen) {
          this.plugin.store.setActiveBranch(this.annotation.id, chosen.parentMessageId, chosen.id);
        }
      }
      // Full render rebuilds the header so the rename button captures the
      // newly-active fork id. refreshMessages alone would leave the old
      // activeForkId closed over inside the rename click handler.
      this.render();
    });

    // Rename button — only enabled when a fork is active (not Main).
    const renameBtn = pickerRow.createEl("button", {
      cls: "annotator-fork-rename-btn clickable-icon",
      attr: { "aria-label": "Rename fork" },
    });
    setIcon(renameBtn, "pencil");
    renameBtn.disabled = activeForkId === null;
    renameBtn.addEventListener("click", () => {
      if (!activeForkId) return;
      const fork = forks.find(f => f.id === activeForkId);
      if (!fork) return;
      this.openForkRenameInput(pickerRow, select, renameBtn, fork);
    });

    // If a fork was just created via the hover button, immediately open its
    // rename input; refocus the message input when the rename finishes.
    if (this.pendingForkRename && this.pendingForkRename === activeForkId) {
      const pending = forks.find(f => f.id === this.pendingForkRename);
      this.pendingForkRename = null;
      if (pending) {
        this.openForkRenameInput(pickerRow, select, renameBtn, pending, () =>
          this.focusInput()
        );
      }
    }
  }

  private openForkRenameInput(
    pickerRow: HTMLElement,
    select: HTMLSelectElement,
    renameBtn: HTMLButtonElement,
    fork: ThreadBranch,
    onFinish?: () => void
  ): void {
    const current = fork.label || "Fork";

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.className = "annotator-fork-rename-input";
    input.setAttribute("aria-label", "Fork name");

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next && next !== current) {
        this.plugin.store.renameBranch(this.annotation.id, fork.id, next);
      }
      // Full render rebuilds the picker; onFinish runs after so it focuses
      // the freshly created textarea.
      this.render();
      onFinish?.();
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      input.remove();
      select.style.display = "";
      renameBtn.disabled = false;
      onFinish?.();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    select.style.display = "none";
    renameBtn.disabled = true;
    pickerRow.insertBefore(input, select);
    input.focus();
    input.select();
  }

  private findActiveForkOnPath(path: ThreadMessage[], forks: ThreadBranch[]): string | null {
    for (const msg of path) {
      const active = this.annotation.thread.activeBranchByParent[msg.id];
      if (active) {
        const match = forks.find(f => f.id === active);
        if (match) return match.id;
      }
    }
    return null;
  }

  private renderMessage(
    msg: ThreadMessage,
    pathIndex: number,
    path: ThreadMessage[],
    isLastAssistant: boolean
  ): void {
    if (!this.messagesEl) return;

    const wrapper = this.messagesEl.createDiv({
      cls: `annotator-chat-msg ${msg.role === "assistant" ? "annotator-chat-msg-ai" : ""}`,
    });

    const aiLabel = (this.plugin.settings.aiDisplayName || "AI").toUpperCase();
    wrapper.createDiv({
      cls: `annotator-chat-role annotator-chat-role-${msg.role === "user" ? "user" : "ai"}`,
      text: msg.role === "user" ? "YOU" : aiLabel,
    });

    const body = wrapper.createDiv({ cls: "annotator-chat-body" });

    // Parse wiki-links first, then handle @#N refs within text segments
    const tokens = NoteSuggest.parseWikiLinks(getText(msg.content), this.plugin.app);

    for (const token of tokens) {
      if (token.type === "wikilink" || token.type === "context-ref" || token.type === "image-ref") {
        const prefix = token.type === "context-ref" ? "@" : "";
        const linkEl = body.createSpan({
          cls: `annotator-wikilink ${token.notePath ? "" : "is-unresolved"}`,
          text: `${prefix}[[${token.text}]]`,
        });
        if (token.notePath) {
          linkEl.addEventListener("click", () => {
            this.plugin.app.workspace.openLinkText(token.notePath!, "");
          });
        }
      } else {
        // Render text segments, parsing @#N refs within them
        this.renderTextWithAnnotationRefs(body, token.text);
      }
    }

    for (const img of getImageParts(msg.content)) {
      const file = this.plugin.app.vault.getAbstractFileByPath(img.vaultPath);
      if (file instanceof TFile) {
        const thumb = body.createEl("img", {
          cls: "annotator-chat-history-image",
          attr: {
            src: this.plugin.app.vault.getResourcePath(file),
            alt: img.vaultPath.split("/").pop() || img.vaultPath,
          },
        });
        thumb.addEventListener("click", () => {
          this.plugin.app.workspace.openLinkText(img.vaultPath, "");
        });
      } else {
        body.createDiv({
          cls: "annotator-chat-history-image is-broken",
          text: `[missing image: ${img.vaultPath}]`,
        });
      }
    }

    for (const doc of getDocumentParts(msg.content)) {
      const file = this.plugin.app.vault.getAbstractFileByPath(doc.vaultPath);
      const chip = body.createDiv({ cls: "annotator-chat-history-document" });
      const iconEl = chip.createSpan({ cls: "annotator-chat-history-document-icon" });
      setIcon(iconEl, "file-text");
      const filename = doc.vaultPath.split("/").pop() || doc.vaultPath;
      chip.createSpan({
        cls: "annotator-chat-history-document-label",
        text: filename,
      });
      if (file instanceof TFile) {
        chip.addClass("is-clickable");
        chip.addEventListener("click", () => {
          this.plugin.app.workspace.openLinkText(doc.vaultPath, "");
        });
      } else {
        chip.addClass("is-broken");
        chip.setAttr("title", `Missing: ${doc.vaultPath}`);
      }
    }

    // Hover-visible fork button — hidden on the latest assistant reply since
    // users can use a slash command there instead.
    if (!isLastAssistant) {
      const forkBtn = wrapper.createEl("button", {
        cls: "annotator-msg-fork-btn clickable-icon",
        attr: { "aria-label": "Fork from this message" },
      });
      setIcon(forkBtn, "git-fork");
      forkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const branch = this.plugin.store.createFork(this.annotation.id, msg.id);
        if (branch) {
          this.pendingForkRename = branch.id;
          this.render();
        }
      });
    }

    if (msg.role === "assistant") {
      const controls = wrapper.createDiv({ cls: "annotator-msg-controls" });
      const navState = getRegenerateNavState(this.annotation.thread, path, pathIndex);
      if (navState) {
        this.renderRegenerateNav(controls, navState);
      }
      if (!isLastAssistant) {
        const regenBtn = controls.createEl("button", {
          cls: "annotator-msg-regen-btn clickable-icon",
          attr: { "aria-label": "Regenerate response" },
        });
        setIcon(regenBtn, "refresh-cw");
        regenBtn.addEventListener("click", () => this.regenerateFromAssistant(pathIndex, path));
      }
    }
  }

  private renderRegenerateNav(
    container: HTMLElement,
    navState: { active: number; total: number; parentUserMsgId: string }
  ): void {
    const prev = container.createEl("button", { cls: "annotator-msg-nav-btn", text: "<" });
    container.createSpan({
      cls: "annotator-msg-nav-label",
      text: `${navState.active}/${navState.total}`,
    });
    const next = container.createEl("button", { cls: "annotator-msg-nav-btn", text: ">" });

    // Regenerate branches ordered the same way as getRegenerateNavState computed.
    const allBranches = this.annotation.thread.branches
      .filter(b => b.kind === "regenerate" && b.parentMessageId === navState.parentUserMsgId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const setActiveByIndex = (idx: number) => {
      // idx: 1 = original reply, 2..N = regenerate siblings
      if (idx < 1 || idx > navState.total) return;
      if (idx === 1) {
        this.plugin.store.setActiveBranch(this.annotation.id, navState.parentUserMsgId, null);
      } else {
        const branch = allBranches[idx - 2];
        if (branch) {
          this.plugin.store.setActiveBranch(this.annotation.id, navState.parentUserMsgId, branch.id);
        }
      }
      this.refreshMessages();
    };

    prev.addEventListener("click", () => setActiveByIndex(navState.active - 1));
    next.addEventListener("click", () => setActiveByIndex(navState.active + 1));
    if (navState.active === 1) prev.disabled = true;
    if (navState.active === navState.total) next.disabled = true;
  }

  private async regenerateFromAssistant(
    pathIndex: number,
    path: ThreadMessage[]
  ): Promise<void> {
    if (this.sending) return;
    const assistantMsg = path[pathIndex];
    if (!assistantMsg || assistantMsg.role !== "assistant") return;
    const parent = path[pathIndex - 1];
    if (!parent || parent.role !== "user") return;

    const provider = this.plugin.providerManager.getActiveProvider();
    if (!provider) {
      this.showNoProviderMessage();
      return;
    }

    const branch = this.plugin.store.createRegenerate(this.annotation.id, parent.id);
    if (!branch) return;
    // createRegenerate already activated the branch — refresh so the original
    // assistant reply is hidden before the loading indicator appears.
    this.refreshMessages();

    this.sending = true;
    this.setInputEnabled(false);
    let loading = this.showLoading();

    const abortController = new AbortController();
    this.abortController = abortController;

    const annotationId = this.annotation.id;
    const parentId = parent.id;
    const branchId = branch.id;
    let pendingError: string | null = null;
    let wasCancelled = false;

    try {
      // History for the AI = active path up to but not including the assistant
      // message being regenerated. The slice captures the path at the time of
      // the click, which is correct: we want the pre-regeneration context.
      const history = path.slice(0, pathIndex).map(m => ({ role: m.role, content: m.content }));

      // Reuse the same prompt-context builder as sendMessage. The "ask"
      // command here is a synthetic restatement of the parent user message
      // so buildPromptContext has something to parse.
      const parsed: ParsedCommand = { type: "ask", content: getText(parent.content) };
      const promptCtx = await this.buildPromptContext(parsed, parent.annotationRefs, parent.contextNoteRefs);
      const systemPrompt = buildSystemPrompt(promptCtx);

      const activeProvider = this.plugin.settings.providers.find(
        p => p.id === this.plugin.settings.activeProviderId
      );

      const onToken = (chunk: string) => {
        if (loading) {
          loading.cleanup();
          loading.el.remove();
          loading = null;
          this.createStreamingBubble();
        }
        this.appendToStreamingBubble(chunk);
      };

      const response = await provider.sendMessage(
        history,
        systemPrompt,
        {
          maxTokens: activeProvider?.maxTokens ?? 1024,
          temperature: activeProvider?.temperature ?? 0.7,
        },
        abortController.signal,
        onToken
      );

      this.removeStreamingBubble();
      const aiMsg = createThreadMessage("assistant", response);
      this.plugin.store.addMessageToBranch(annotationId, branchId, aiMsg);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        wasCancelled = true;
      } else {
        pendingError = err instanceof Error ? err.message : "Unknown error";
      }
    } finally {
      this.abortController = null;
      loading?.cleanup();
      loading?.el.remove();
      this.removeStreamingBubble();
      this.setInputEnabled(true);
      this.sending = false;
      if (wasCancelled) {
        // Back out the branch activation so the original reply becomes visible
        // again. The empty branch is left in thread.branches — harmless and
        // can be garbage-collected by a future sweep.
        this.plugin.store.setActiveBranch(annotationId, parentId, null);
      }
      if (pendingError) {
        this.plugin.store.setActiveBranch(annotationId, parentId, null);
      }
      this.renderMessages();
      if (wasCancelled) this.addSystemMessage("Regenerate cancelled.");
      if (pendingError) this.showError(pendingError);
    }
  }

  private renderTextWithAnnotationRefs(container: HTMLElement, text: string): void {
    const refPattern = /@#(\d+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = refPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendText(text.slice(lastIndex, match.index));
      }
      const refNum = match[1];
      const refLink = container.createSpan({ cls: "annotator-ref-link", text: `@#${refNum}` });
      refLink.addEventListener("click", () => {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile) return;
        const anns = this.plugin.store.getForFile(activeFile.path);
        const sorted = [...anns].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const target = sorted[parseInt(refNum) - 1];
        if (target) this.plugin.scrollToAnnotation(target);
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.appendText(text.slice(lastIndex));
    }
  }

  private startRename(titleEl: HTMLElement): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = this.annotation.label;
    input.placeholder = "Untitled";
    input.className = "annotator-rename-input";
    input.setAttribute("aria-label", "Rename thread");

    const commit = () => {
      const newLabel = input.value.trim();
      if (newLabel !== this.annotation.label) {
        this.annotation.label = newLabel;
        this.plugin.store.updateAnnotation(this.annotation.id, { label: newLabel });
      }
      titleEl.textContent = newLabel || "Untitled";
      titleEl.style.display = "";
      input.remove();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        titleEl.textContent = this.annotation.label || "Untitled";
        titleEl.style.display = "";
        input.remove();
      }
    });

    titleEl.style.display = "none";
    titleEl.parentElement?.insertBefore(input, titleEl);
    input.focus();
    input.select();
  }

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || this.sending) return;
    const content = this.inputEl.value.trim();
    if (!content && this.pendingAttachments.length === 0) return;

    this.sending = true;
    this.inputEl.value = "";
    this.autoGrowInput();
    this.hideCommandSuggest();

    const parsed = this.parseCommand(content);

    if (parsed.type === "builtin") {
      await this.handleBuiltInCommand(parsed.command, parsed.content);
    } else {
      // "ask" path — goes through the AI
      const refs = parseAnnotationRefs(content);
      const noteRefNames = parseContextNoteRefs(content);
      const contextNoteRefs: string[] = [];
      for (const name of noteRefNames) {
        const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(name, "");
        if (resolved) {
          contextNoteRefs.push(resolved.path);
        }
      }

      // Merge in any /attach-pending context notes (text files picked via file picker).
      for (const item of this.pendingAttachments) {
        if (item.kind !== "context") continue;
        if (!contextNoteRefs.includes(item.vaultPath)) {
          contextNoteRefs.push(item.vaultPath);
        }
      }

      const allTokens = NoteSuggest.parseWikiLinks(content, this.plugin.app);
      for (const token of allTokens) {
        if (token.type !== "image-ref" || !token.notePath) continue;
        if (this.pendingAttachments.some(p => p.kind === "image" && p.part.vaultPath === token.notePath)) continue;
        const file = this.plugin.app.vault.getAbstractFileByPath(token.notePath);
        if (!(file instanceof TFile)) continue;
        const mime = extToMime(file.extension);
        if (!mime) continue;
        this.pendingAttachments.push({
          kind: "image",
          part: { type: "image", vaultPath: file.path, mimeType: mime },
        });
      }

      const media: Array<ImagePart | DocumentPart> = this.pendingAttachments
        .filter((p): p is Extract<PendingItem, { kind: "image" | "document" }> =>
          p.kind === "image" || p.kind === "document"
        )
        .map(p => p.part);
      const userContent = makeContent(content, media);
      const userMsg = createThreadMessage("user", userContent, refs, contextNoteRefs);
      const leafBranchId = this.getLeafBranchId();
      if (leafBranchId) {
        this.plugin.store.addMessageToBranch(this.annotation.id, leafBranchId, userMsg);
      } else {
        this.plugin.store.addMessage(this.annotation.id, userMsg);
      }
      this.pendingAttachments = [];
      this.renderAttachmentChips();
      this.renderMessages();

      // Check for configured provider
      const provider = this.plugin.providerManager.getActiveProvider();
      if (!provider) {
        this.showNoProviderMessage();
        this.sending = false;
        return;
      }

      // Build context for system prompt
      const promptCtx = await this.buildPromptContext(parsed, refs, contextNoteRefs);

      // Show loading state
      this.setInputEnabled(false);
      let loading = this.showLoading();

      // Fire the AI call — decoupled from view state
      const annotationId = this.annotation.id;
      const abortController = new AbortController();
      this.abortController = abortController;

      // Error is rendered *after* renderMessages() in the finally block,
      // otherwise renderMessages would wipe it out (it empties messagesEl).
      let pendingError: string | null = null;
      let wasCancelled = false;
      let timedOut = false;

      // Slow-hint timer: if nothing has streamed after 15s, show a hint inside
      // the loading indicator. When attachments are pending on a non-vision
      // model, phrase the hint to point at vision capability.
      // Inactivity timer: if no tokens arrive for 60s, auto-abort. The timer
      // is reset on each token so long responses aren't killed mid-stream.
      const SLOW_HINT_MS = 15000;
      const INACTIVITY_ABORT_MS = 60000;
      const activeProvider = this.plugin.settings.providers.find(
        p => p.id === this.plugin.settings.activeProviderId
      );
      const hasAttachmentsInFlight =
        Array.isArray(userContent) && userContent.some(p => p.type === "image" || p.type === "document");
      const modelName = activeProvider?.model ?? "";
      const slowHintText = hasAttachmentsInFlight && !modelLikelySupportsVision(modelName)
        ? "Taking longer than expected. Check that the selected model supports vision input."
        : "Taking longer than expected. Press Esc to cancel.";

      let slowTimer: number | null = window.setTimeout(() => {
        slowTimer = null;
        if (!loading?.el) return;
        const existing = loading.el.querySelector(".annotator-chat-loading-slow-hint");
        if (existing) return;
        loading.el.createDiv({
          cls: "annotator-chat-loading-slow-hint",
          text: slowHintText,
        });
      }, SLOW_HINT_MS);

      let inactivityTimer: number | null = null;
      const armInactivityTimer = () => {
        if (inactivityTimer !== null) window.clearTimeout(inactivityTimer);
        inactivityTimer = window.setTimeout(() => {
          inactivityTimer = null;
          if (this.abortController) {
            timedOut = true;
            this.abortController.abort();
          }
        }, INACTIVITY_ABORT_MS);
      };
      armInactivityTimer();

      try {
        const systemPrompt = buildSystemPrompt(promptCtx);
        const threadMessages = getActivePath(this.annotation.thread)
          .filter(m => m.role === "user" || m.role === "assistant")
          .map(m => ({ role: m.role, content: m.content }));

        const onToken = (chunk: string) => {
          // First token: tear down the loading indicator and create the live bubble.
          if (loading) {
            loading.cleanup();
            loading.el.remove();
            loading = null;
            this.createStreamingBubble();
          }
          // Cancel the slow-hint timer — we're past "thinking" and into streaming.
          if (slowTimer !== null) {
            window.clearTimeout(slowTimer);
            slowTimer = null;
          }
          // Reset inactivity timer on every token so a healthy stream keeps going.
          armInactivityTimer();
          this.appendToStreamingBubble(chunk);
        };

        const response = await provider.sendMessage(
          threadMessages,
          systemPrompt,
          {
            maxTokens: activeProvider?.maxTokens ?? 1024,
            temperature: activeProvider?.temperature ?? 0.7,
          },
          abortController.signal,
          onToken
        );

        // Remove the ephemeral bubble *before* adding the stored message so the
        // subsequent renderMessages() doesn't momentarily show both.
        this.removeStreamingBubble();

        const aiMsg = createThreadMessage("assistant", response);
        if (leafBranchId) {
          this.plugin.store.addMessageToBranch(annotationId, leafBranchId, aiMsg);
        } else {
          this.plugin.store.addMessage(annotationId, aiMsg);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          if (timedOut) {
            pendingError = hasAttachmentsInFlight && !modelLikelySupportsVision(modelName)
              ? "Request timed out. The selected model may not support vision input — try a vision-capable model"
              : "Request timed out after 60 seconds of no response";
          } else {
            wasCancelled = true;
          }
        } else {
          pendingError = err instanceof Error ? err.message : "Unknown error";
        }
      } finally {
        if (slowTimer !== null) window.clearTimeout(slowTimer);
        if (inactivityTimer !== null) window.clearTimeout(inactivityTimer);
        this.abortController = null;
        loading?.cleanup();
        loading?.el.remove();
        // If the stream was interrupted before completing (abort or error), the
        // ephemeral bubble may still be in the DOM. Tear it down before the
        // renderMessages() call below, otherwise it would sit above the rendered
        // history until the next re-render.
        this.removeStreamingBubble();
        this.setInputEnabled(true);
        this.renderMessages();
        if (wasCancelled) this.addSystemMessage("Request cancelled.");
        if (pendingError) this.showError(pendingError);
      }
    }

    this.sending = false;
  }

  /** Parse user input into a command */
  private parseCommand(text: string): ParsedCommand {
    const trimmed = text.trim();

    // Built-in commands
    if (trimmed.startsWith("/skip")) {
      return { type: "builtin", command: "skip", content: trimmed.slice(5).trim() };
    }
    if (trimmed.startsWith("/find ")) {
      return { type: "builtin", command: "find", content: trimmed.slice(6).trim() };
    }
    if (trimmed === "/find") {
      return { type: "builtin", command: "find", content: "" };
    }
    if (trimmed.startsWith("/ctx ")) {
      return { type: "builtin", command: "ctx", content: trimmed.slice(5).trim() };
    }
    if (trimmed === "/ctx") {
      return { type: "builtin", command: "ctx", content: "" };
    }
    if (trimmed.startsWith("/search ")) {
      return { type: "builtin", command: "search", content: trimmed.slice(8).trim() };
    }
    if (trimmed === "/search") {
      return { type: "builtin", command: "search", content: "" };
    }
    if (trimmed === "/link" || trimmed.startsWith("/link ")) {
      return { type: "builtin", command: "link", content: trimmed.slice(5).trim() };
    }
    if (trimmed === "/export") {
      return { type: "builtin", command: "export", content: "" };
    }
    if (trimmed === "/copylink") {
      return { type: "builtin", command: "copylink", content: "" };
    }
    if (trimmed === "/attach") {
      return { type: "builtin", command: "attach", content: "" };
    }

    return { type: "ask", content: trimmed };
  }

  /** Handle built-in (non-AI) commands */
  private async handleBuiltInCommand(command: string, content: string): Promise<void> {
    switch (command) {
      case "skip":
        this.handleSkip(content);
        break;
      case "find":
        this.handleFind(content);
        break;
      case "ctx":
        this.handleCtx(content);
        break;
      case "search":
        this.handleSearch(content);
        break;
      case "link":
        this.handleLink(content);
        break;
      case "attach":
        await this.handleAttach();
        break;
      case "export":
        await this.handleExport();
        break;
      case "copylink":
        this.handleCopyLink();
        break;
    }
  }

  /** /skip — leave a comment without calling the AI */
  private handleSkip(content: string): void {
    const text = content || "(comment)";
    const msg = createThreadMessage("user", `💬 ${text}`);
    this.storeMessage(msg);
    this.renderMessages();
  }

  /** /find — search within the document text */
  private handleFind(query: string): void {
    if (!query) {
      this.addSystemMessage("Usage: /find <search term>");
      return;
    }

    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      this.addSystemMessage("No active file to search.");
      return;
    }

    const cache = this.plugin.app.vault.cachedRead(activeFile);
    cache.then((docText) => {
      const lower = docText.toLowerCase();
      const queryLower = query.toLowerCase();
      const matches: string[] = [];
      let pos = 0;

      while (matches.length < 5) {
        const idx = lower.indexOf(queryLower, pos);
        if (idx === -1) break;
        const start = Math.max(0, idx - 40);
        const end = Math.min(docText.length, idx + query.length + 40);
        const snippet = (start > 0 ? "..." : "") +
          docText.slice(start, end).replace(/\n/g, " ") +
          (end < docText.length ? "..." : "");
        matches.push(snippet);
        pos = idx + 1;
      }

      if (matches.length === 0) {
        this.addSystemMessage(`No matches found for "${query}".`);
      } else {
        const result = `Found ${matches.length} match${matches.length > 1 ? "es" : ""} for "${query}":\n\n` +
          matches.map((m, i) => `${i + 1}. ${m}`).join("\n");
        this.addSystemMessage(result);
      }
    });
  }

  /** /ctx — include full document context (modifier for next AI call) */
  private handleCtx(content: string): void {
    if (!content) {
      this.addSystemMessage("📄 Document context will be included with your next message. Type your question after /ctx.");
      return;
    }

    // When AI is wired up, this will pass the full doc text as context
    const refs = parseAnnotationRefs(content);
    const userMsg = createThreadMessage("user", `📄 ${content}`, refs);
    this.storeMessage(userMsg);
    this.renderMessages();

    const aiMsg = createThreadMessage("assistant", "AI providers will be connected in Phase 2. The /ctx flag will include full document context with your prompt.");
    this.storeMessage(aiMsg);
    this.renderMessages();
  }

  /** /search — ask AI with web search enabled */
  private handleSearch(content: string): void {
    if (!content) {
      this.addSystemMessage("Usage: /search <question>");
      return;
    }

    const refs = parseAnnotationRefs(content);
    const userMsg = createThreadMessage("user", `🌐 ${content}`, refs);
    this.storeMessage(userMsg);
    this.renderMessages();

    const aiMsg = createThreadMessage("assistant", "AI providers will be connected in Phase 2. The /search flag will enable web search with your prompt.");
    this.storeMessage(aiMsg);
    this.renderMessages();
  }

  /** /link — insert a reference to another annotation */
  private handleLink(content: string): void {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      this.addSystemMessage("No active file.");
      return;
    }

    const anns = this.plugin.store.getForFile(activeFile.path);
    const sorted = [...anns].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Filter out current annotation
    const others = sorted.filter(a => a.id !== this.annotation.id);
    if (others.length === 0) {
      this.addSystemMessage("No other annotations in this file to link to.");
      return;
    }

    // If content is a number, link directly
    const num = parseInt(content);
    if (!isNaN(num) && num >= 1 && num <= sorted.length) {
      const target = sorted[num - 1];
      if (target.id === this.annotation.id) {
        this.addSystemMessage("Cannot link an annotation to itself.");
        return;
      }
      this.insertLink(target, sorted);
      return;
    }

    // Show a list of available annotations to link
    const list = others.map((a) => {
      const n = sorted.indexOf(a) + 1;
      const label = a.label || a.excerpt.slice(0, 40);
      return `#${n}: ${label}`;
    }).join("\n");

    this.addSystemMessage(`Available annotations to link:\n\n${list}\n\nType /link <number> to create a link.`);
  }

  private insertLink(target: Annotation, sorted: Annotation[]): void {
    const targetNum = sorted.indexOf(target) + 1;

    // Add to linkedAnnotations if not already there
    if (!this.annotation.linkedAnnotations.includes(target.id)) {
      this.annotation.linkedAnnotations.push(target.id);
      this.plugin.store.updateAnnotation(this.annotation.id, {
        linkedAnnotations: this.annotation.linkedAnnotations,
      });
    }

    const label = target.label || target.excerpt.slice(0, 40);
    this.addSystemMessage(`🔗 Linked to @#${targetNum} (${label})`);

    // Put the @#N ref in the input for the user to use in their next message
    if (this.inputEl) {
      this.inputEl.value = `@#${targetNum} `;
      this.inputEl.focus();
    }
  }

  /** /export — export this annotation to a new note */
  private async handleExport(): Promise<void> {
    const exportPath = await this.plugin.exportAnnotationToNote(this.annotation);
    const basename = exportPath.replace(/\.md$/, "").split("/").pop() || exportPath;
    this.addSystemMessage(`Exported to [[${basename}]]`);
  }

  /** /copylink — copy a deep link to this annotation's chat */
  private handleCopyLink(): void {
    const uri = `obsidian://annotator?id=${encodeURIComponent(this.annotation.id)}&file=${encodeURIComponent(this.annotation.fileVaultPath)}`;
    const label = this.annotation.label || this.annotation.excerpt.slice(0, 40);
    const link = `[${label}](${uri})`;
    navigator.clipboard.writeText(link);
    this.addSystemMessage("Link copied to clipboard.");
  }

  /** Write a message to the active leaf branch, or to the main thread if on Main. */
  private storeMessage(msg: ThreadMessage): void {
    const leafBranchId = this.getLeafBranchId();
    if (leafBranchId) {
      this.plugin.store.addMessageToBranch(this.annotation.id, leafBranchId, msg);
    } else {
      this.plugin.store.addMessage(this.annotation.id, msg);
    }
  }

  /** Add a system-style message to the thread */
  private addSystemMessage(text: string): void {
    const msg = createThreadMessage("assistant", text);
    this.storeMessage(msg);
    this.renderMessages();
  }

  /** Build the PromptContext for the system prompt */
  private async buildPromptContext(
    parsed: ParsedCommand,
    refs: string[],
    contextNoteRefPaths: string[]
  ): Promise<PromptContext> {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const filename = activeFile?.basename || "unknown";

    // Resolve @#N references
    const referencedAnnotations: PromptContext["referencedAnnotations"] = [];
    if (refs.length > 0 && activeFile) {
      const anns = this.plugin.store.getForFile(activeFile.path);
      const sorted = [...anns].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      for (const refNum of refs) {
        const idx = parseInt(refNum) - 1;
        if (idx >= 0 && idx < sorted.length) {
          const ref = sorted[idx];
          referencedAnnotations.push({
            number: idx + 1,
            excerpt: ref.excerpt,
            label: ref.label,
          });
        }
      }
    }

    // Resolve @[[Note]] context notes
    const contextNotes: PromptContext["contextNotes"] = [];
    for (const notePath of contextNoteRefPaths) {
      const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) {
        const noteContent = await this.plugin.app.vault.cachedRead(file);
        if (noteContent.length > NOTE_CONTENT_LIMIT) {
          this.addSystemMessage(
            `Note [[${file.basename}]] is ${noteContent.length.toLocaleString()} characters \u2014 only the first 4,000 will be included as context.`
          );
        }
        contextNotes.push({ name: file.basename, content: noteContent });
      }
    }

    const ctx: PromptContext = {
      annotation: this.annotation,
      filename,
      referencedAnnotations,
      contextNotes,
    };

    return ctx;
  }

  /** Show a loading indicator in the messages area.
   *  Returns an object with an element and a cleanup function; callers
   *  must call cleanup() to clear the rotating-hint interval. */
  private showLoading(): { el: HTMLElement; cleanup: () => void } | null {
    if (!this.messagesEl) return null;
    const loading = this.messagesEl.createDiv({ cls: "annotator-chat-loading" });

    const top = loading.createDiv({ cls: "annotator-chat-loading-top" });
    const dots = top.createDiv({ cls: "annotator-chat-loading-dots" });
    dots.createDiv({ cls: "annotator-chat-loading-dot" });
    dots.createDiv({ cls: "annotator-chat-loading-dot" });
    dots.createDiv({ cls: "annotator-chat-loading-dot" });
    top.createSpan({ cls: "annotator-chat-loading-text", text: "Thinking..." });

    // Rotating hint line — appears after 3 seconds, then cycles every 4s.
    const hintEl = loading.createDiv({ cls: "annotator-chat-loading-hint" });
    hintEl.addClass("is-hidden");

    const hints = [
      "Press Esc to cancel",
      "Tip: use @#N to reference another annotation",
      "Tip: use @[[Note]] to include note content",
      "Tip: type / to browse slash commands",
    ];
    let idx = 0;
    const showHint = () => {
      hintEl.setText(hints[idx % hints.length]);
      hintEl.removeClass("is-hidden");
      idx++;
    };

    const initialTimeout = window.setTimeout(() => {
      showHint();
    }, 3000);
    const interval = window.setInterval(() => {
      if (idx === 0) return;
      showHint();
    }, 4000);

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    return {
      el: loading,
      cleanup: () => {
        window.clearTimeout(initialTimeout);
        window.clearInterval(interval);
      },
    };
  }

  /** Show an error message in the thread, with a trailing link to settings. */
  private showError(message: string): void {
    if (!this.messagesEl) return;
    const errorEl = this.messagesEl.createDiv({ cls: "annotator-chat-error" });
    const textEl = errorEl.createDiv({ cls: "annotator-chat-error-text" });
    textEl.appendText(`${message} Check your `);
    this.appendSettingsLink(textEl);
    textEl.appendText(".");
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Show the "no AI provider" message with a clickable "settings" link. */
  private showNoProviderMessage(): void {
    if (!this.messagesEl) return;
    const errorEl = this.messagesEl.createDiv({ cls: "annotator-chat-error" });
    const textEl = errorEl.createDiv({ cls: "annotator-chat-error-text" });
    textEl.appendText("No AI provider configured. Set one up in ");
    this.appendSettingsLink(textEl);
    textEl.appendText(".");
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Append a clickable "settings" link that opens this plugin's settings tab. */
  private appendSettingsLink(parent: HTMLElement): void {
    const link = parent.createEl("a", {
      text: "settings",
      cls: "annotator-settings-link",
      href: "#",
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      // Obsidian's setting API is not formally typed; use a structural cast.
      const setting = (this.plugin.app as unknown as {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });
  }

  /** Create an ephemeral "streaming" assistant bubble in the messages area.
   *  The bubble is rendered as plain text (no wiki-link / @#N parsing) because
   *  tokens arrive incrementally — a partial "[[Note" or "@#1" would render
   *  incorrectly mid-stream. Full rich rendering happens once the completed
   *  message lands in the store and renderMessages() swaps it in. */
  private createStreamingBubble(): HTMLElement {
    if (!this.messagesEl) {
      throw new Error("messagesEl not ready");
    }
    const wrapper = this.messagesEl.createDiv({
      cls: "annotator-chat-msg annotator-chat-msg-ai annotator-chat-msg-streaming",
    });
    const aiLabel = (this.plugin.settings.aiDisplayName || "AI").toUpperCase();
    wrapper.createDiv({
      cls: "annotator-chat-role annotator-chat-role-ai",
      text: aiLabel,
    });
    wrapper.createDiv({ cls: "annotator-chat-body" });
    this.streamingBubbleEl = wrapper;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return wrapper;
  }

  /** Append a chunk of streamed text to the live bubble and auto-scroll.
   *  No-op if there's no streaming bubble yet. */
  private appendToStreamingBubble(chunk: string): void {
    if (!this.streamingBubbleEl) return;
    const body = this.streamingBubbleEl.querySelector(".annotator-chat-body");
    if (!body) return;
    body.appendText(chunk);
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  /** Remove the streaming bubble and clear the field. Idempotent. */
  private removeStreamingBubble(): void {
    this.streamingBubbleEl?.remove();
    this.streamingBubbleEl = null;
  }

  /** Enable or disable the send button while keeping the textarea interactive.
   *  The textarea stays enabled during in-flight requests so the user can (a)
   *  press Escape to cancel — a disabled textarea cannot receive keystrokes,
   *  and (b) start composing the next message while waiting. The `sending`
   *  flag + disabled send button prevent concurrent sends. */
  private setInputEnabled(enabled: boolean): void {
    const sendBtn = this.containerEl.querySelector(".annotator-send-btn") as HTMLButtonElement | null;
    if (sendBtn) {
      sendBtn.disabled = !enabled;
    }
  }

  // --- Command suggest dropdown ---

  private onInputChanged(): void {
    if (!this.inputEl) return;
    const value = this.inputEl.value;

    // Show command suggest when input starts with "/" and has no space yet (browsing commands)
    // or when the whole input is just a partial slash command
    if (value.startsWith("/") && !value.includes(" ")) {
      this.showCommandSuggest(value);
    } else {
      this.hideCommandSuggest();
    }
  }

  private showCommandSuggest(partial: string): void {
    if (!this.inputEl) return;

    // Gather all built-in commands
    const allCommands: Array<{ trigger: string; label: string; description: string; icon: string }> = [];
    for (const cmd of BUILT_IN_COMMANDS) {
      allCommands.push(cmd);
    }

    // Filter by partial match
    const query = partial.toLowerCase();
    const filtered = allCommands.filter(c => c.trigger.toLowerCase().startsWith(query));
    if (filtered.length === 0) {
      this.hideCommandSuggest();
      return;
    }

    // Create or reuse suggest container — prepend so it appears above the input row
    if (!this.commandSuggestEl && this.inputAreaEl) {
      this.commandSuggestEl = this.inputAreaEl.createDiv({ cls: "annotator-command-suggest" });
      // Move to first child so it renders above the input row
      this.inputAreaEl.insertBefore(this.commandSuggestEl, this.inputAreaEl.firstChild);
    }
    if (!this.commandSuggestEl) return;
    this.commandSuggestEl.empty();
    this.commandSuggestEl.removeClass("annotator-hidden");

    for (const [i, cmd] of filtered.entries()) {
      const item = this.commandSuggestEl.createDiv({
        cls: `annotator-command-item${i === 0 ? " is-selected" : ""}`,
      });
      const iconEl = item.createSpan({ cls: "annotator-command-icon" });
      setIcon(iconEl, cmd.icon);
      const textEl = item.createDiv({ cls: "annotator-command-text" });
      textEl.createDiv({ cls: "annotator-command-trigger", text: cmd.trigger });
      textEl.createDiv({ cls: "annotator-command-desc", text: cmd.description });

      item.addEventListener("click", () => {
        if (!this.inputEl) return;
        this.inputEl.value = cmd.trigger + " ";
        this.inputEl.focus();
        this.hideCommandSuggest();
      });

      item.addEventListener("mouseenter", () => {
        this.commandSuggestEl?.querySelectorAll(".annotator-command-item").forEach(el =>
          el.removeClass("is-selected")
        );
        item.addClass("is-selected");
      });
    }
  }

  private hideCommandSuggest(): void {
    if (this.commandSuggestEl) {
      this.commandSuggestEl.addClass("annotator-hidden");
    }
  }

  private navigateCommandSuggest(direction: 1 | -1): void {
    if (!this.commandSuggestEl) return;
    const items = Array.from(this.commandSuggestEl.querySelectorAll(".annotator-command-item"));
    const current = items.findIndex(el => el.hasClass("is-selected"));
    if (current === -1) return;

    items[current].removeClass("is-selected");
    const next = (current + direction + items.length) % items.length;
    items[next].addClass("is-selected");
  }
}
