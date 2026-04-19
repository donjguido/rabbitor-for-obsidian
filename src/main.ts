import { App, MarkdownView, Modal, Plugin, TFile, Notice, Editor, type MarkdownFileInfo } from "obsidian";
import type { EditorView as CMEditorView } from "@codemirror/view";
import { AnnotatorView, VIEW_TYPE_ANNOTATOR } from "./views/AnnotatorView";
import { AnnotatorSettingsTab } from "./settings/SettingsTab";
import { AnnotationStore } from "./store/AnnotationStore";
import { createHighlightExtension, createHighlightClickHandler, createHighlightPositionSync, setHighlights } from "./editor/HighlightExtension";
import type { HighlightInfo } from "./editor/HighlightExtension";
import { createSelectionMenu } from "./editor/SelectionMenu";
import { createDeletionGuard } from "./editor/DeletionGuard";
import { createReadingModeProcessor } from "./editor/ReadingModeHighlight";
import { DEFAULT_SETTINGS } from "./constants";
import type { Annotation, AnnotatorSettings } from "./types";
import { ProviderManager } from "./ai/ProviderManager";
import { getText, getImageParts, getDocumentParts } from "./ai/messageContent";

export default class AnnotatorPlugin extends Plugin {
  store!: AnnotationStore;
  settings: AnnotatorSettings = { ...DEFAULT_SETTINGS };
  providerManager!: ProviderManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new AnnotationStore(this);
    await this.store.load();
    this.providerManager = new ProviderManager(
      this.app,
      this.settings.providers,
      this.settings.activeProviderId
    );

    this.registerView(
      VIEW_TYPE_ANNOTATOR,
      (leaf) => new AnnotatorView(leaf, this)
    );

    this.registerEditorExtension(createHighlightExtension());
    this.registerEditorExtension(createHighlightClickHandler((id) => this.onHighlightClick(id)));
    this.registerEditorExtension(createSelectionMenu(this));
    this.registerEditorExtension(
      createHighlightPositionSync(
        () => this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null,
        (filePath, updates) => this.store.updatePositions(filePath, updates)
      )
    );
    this.registerEditorExtension(
      createDeletionGuard({
        filterWarnable: (ids) =>
          ids.filter((id) => {
            const ann = this.store.getById(id);
            return !!ann && ann.thread.messages.length > 0;
          }),
        confirmDeletion: (ids) => {
          const count = ids.length;
          const messageTotal = ids.reduce(
            (sum, id) => sum + (this.store.getById(id)?.thread.messages.length ?? 0),
            0
          );
          const label = count === 1 ? "annotation" : "annotations";
          const msgLabel = messageTotal === 1 ? "message" : "messages";
          return new Promise<boolean>((resolve) => {
            new ConfirmModal(this.app, {
              title: "Delete annotated text?",
              body:
                `This will remove ${count} ${label} and its ${messageTotal} chat ${msgLabel}. ` +
                `The annotated text will also be deleted from the note. This cannot be undone.`,
              confirmText: "Delete",
              cancelText: "Cancel",
              destructive: true,
              onResolve: resolve,
            }).open();
          });
        },
        onCollapsed: (ids) => {
          for (const id of ids) {
            if (this.store.getById(id)) {
              this.store.deleteAnnotation(id);
            }
          }
        },
      })
    );

    this.registerMarkdownPostProcessor(createReadingModeProcessor(this));

    this.addRibbonIcon("highlighter", "Annotator", () => {
      this.activateView();
    });

    this.addCommand({
      id: "toggle-panel",
      name: "Toggle annotator panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "annotate-selection",
      name: "Annotate selected text",
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        const selection = editor.getSelection();
        if (!selection || !ctx.file) return;
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const annotation = this.store.createAnnotation(
          ctx.file.path,
          selection,
          from,
          to
        );
        this.openChatForAnnotation(annotation);
      },
    });

    this.addCommand({
      id: "next-annotation",
      name: "Go to next annotation",
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (!ctx.file) return;
        this.navigateAnnotation(ctx.file.path, editor, 1);
      },
    });

    this.addCommand({
      id: "prev-annotation",
      name: "Go to previous annotation",
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (!ctx.file) return;
        this.navigateAnnotation(ctx.file.path, editor, -1);
      },
    });

    this.addCommand({
      id: "export-annotations-json",
      name: "Export annotations as JSON",
      callback: () => this.exportAnnotations("json"),
    });

    this.addCommand({
      id: "export-annotations-markdown",
      name: "Export annotations as markdown",
      callback: () => this.exportAnnotations("markdown"),
    });

    this.addCommand({
      id: "toggle-color-picker",
      name: "Toggle color picker on selection",
      callback: async () => {
        this.settings.showColorPicker = !this.settings.showColorPicker;
        await this.saveSettings();
        new Notice(`Color picker ${this.settings.showColorPicker ? "enabled" : "disabled"}`);
      },
    });

    this.addCommand({
      id: "delete-annotation",
      name: "Delete selected annotation",
      callback: () => {
        const annotatorView = this.getAnnotatorView();
        if (annotatorView?.selectedAnnotation) {
          this.store.deleteAnnotation(annotatorView.selectedAnnotation.id);
          annotatorView.selectedAnnotation = null;
          annotatorView.refresh();
        }
      },
    });

    this.addSettingTab(new AnnotatorSettingsTab(this.app, this));

    this.registerObsidianProtocolHandler("annotator", async (params) => {
      this.handleAnnotatorUri(params);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshHighlights();
        this.getAnnotatorView()?.refresh();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.store.onFileRename(oldPath, file.path);
        }
      })
    );

    // Context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection();
        if (selection && view instanceof MarkdownView && view.file) {
          const filePath = view.file.path;
          const from = editor.posToOffset(editor.getCursor("from"));
          const to = editor.posToOffset(editor.getCursor("to"));
          menu.addItem((item) => {
            item
              .setTitle("Annotate selection")
              .setIcon("highlighter")
              .onClick(() => {
                const annotation = this.store.createAnnotation(filePath, selection, from, to);
                this.openChatForAnnotation(annotation);
              });
          });
        }
      })
    );
  }

  async onunload(): Promise<void> {
    await this.store.save();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    if (data?.settings) {
      this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
    // Migrate: strip legacy slashCommands from persisted settings
    if ((this.settings as any).slashCommands) {
      delete (this.settings as any).slashCommands;
      const data2 = (await this.loadData()) || {};
      data2.settings = this.settings;
      await this.saveData(data2);
    }
  }

  async saveSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    data.settings = this.settings;
    await this.saveData(data);
    this.providerManager.rebuild(
      this.settings.providers,
      this.settings.activeProviderId
    );
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ANNOTATOR)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      await rightLeaf.setViewState({
        type: VIEW_TYPE_ANNOTATOR,
        active: true,
      });
      leaf = rightLeaf;
    }
    workspace.revealLeaf(leaf);
  }

  getAnnotatorView(): AnnotatorView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATOR);
    if (leaves.length > 0) {
      return leaves[0].view as AnnotatorView;
    }
    return null;
  }

  /**
   * Re-dispatches highlight decorations for a specific file's open markdown
   * view(s). When no `filePath` is given, falls back to the active markdown
   * view — but note that when a sidebar view has focus, `getActiveViewOfType`
   * returns null, so callers that know the file (e.g., store change events)
   * should always pass it explicitly.
   */
  refreshHighlights(filePath?: string): void {
    const targets: MarkdownView[] = [];
    if (filePath) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === filePath) {
          targets.push(view);
        }
      }
    } else {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (active?.file) targets.push(active);
    }
    if (targets.length === 0) return;

    for (const view of targets) {
      const path = view.file?.path;
      if (!path) continue;
      const annotations = this.store.getForFile(path);
      const sorted = [...annotations].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const highlights: HighlightInfo[] = sorted.map((ann, i) => ({
        id: ann.id,
        from: ann.from,
        to: ann.to,
        color: ann.color,
        number: i + 1,
      }));
      // @ts-expect-error — Obsidian internal: MarkdownView exposes cm editor
      const cmEditor = view.editor?.cm as CMEditorView | undefined;
      if (cmEditor) {
        cmEditor.dispatch({
          effects: setHighlights.of(highlights),
        });
      }
    }
  }

  onAnnotationsChanged(filePath: string): void {
    this.refreshHighlights(filePath);
    this.getAnnotatorView()?.refresh();
  }

  async openChatForAnnotation(annotation: Annotation): Promise<void> {
    if (!this.settings.openChatAfterAnnotation) return;
    await this.activateView();
    this.getAnnotatorView()?.selectAnnotation(annotation);
  }

  scrollToAnnotation(annotation: Annotation): void {
    // Find the markdown leaf for this annotation's file, since getActiveViewOfType
    // returns null when a sidebar view (like Annotator panel) has focus.
    let markdownView: MarkdownView | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === annotation.fileVaultPath) {
        markdownView = view;
        break;
      }
    }
    if (!markdownView?.editor) return;

    // Reveal the leaf first so the editor is visible
    this.app.workspace.revealLeaf(markdownView.leaf);

    const pos = markdownView.editor.offsetToPos(annotation.from);
    markdownView.editor.setCursor(pos);
    markdownView.editor.scrollIntoView(
      { from: markdownView.editor.offsetToPos(annotation.from), to: markdownView.editor.offsetToPos(annotation.to) },
      true
    );
  }

  private async handleAnnotatorUri(params: Record<string, string>): Promise<void> {
    const { id, file } = params;
    if (!id || !file) return;

    const annotation = this.store.getById(id);
    if (!annotation) {
      new Notice("Annotation not found.");
      return;
    }

    // Open the file
    const tfile = this.app.vault.getAbstractFileByPath(file);
    if (!(tfile instanceof TFile)) {
      new Notice("File not found.");
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(tfile);

    // Wait for the editor to initialize after opening the file
    await new Promise<void>((resolve) => {
      const check = () => {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.editor) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    this.refreshHighlights();
    this.scrollToAnnotation(annotation);
    await this.activateView();
    this.getAnnotatorView()?.selectAnnotation(annotation);
  }

  private async onHighlightClick(annotationId: string): Promise<void> {
    const annotation = this.store.getById(annotationId);
    if (!annotation) return;
    await this.activateView();
    this.getAnnotatorView()?.selectAnnotation(annotation);
  }

  private navigateAnnotation(filePath: string, editor: Editor, direction: 1 | -1): void {
    const anns = this.store.getForFile(filePath);
    if (anns.length === 0) return;

    const sorted = [...anns].sort((a, b) => a.from - b.from);
    const cursor = editor.posToOffset(editor.getCursor());

    let target: Annotation | undefined;
    if (direction === 1) {
      target = sorted.find(a => a.from > cursor) || sorted[0];
    } else {
      target = [...sorted].reverse().find(a => a.from < cursor) || sorted[sorted.length - 1];
    }

    if (target) {
      this.scrollToAnnotation(target);
      const view = this.getAnnotatorView();
      if (view) {
        view.selectAnnotation(target);
      }
    }
  }

  async exportAnnotationToNote(annotation: Annotation): Promise<string> {
    const activeFile = this.app.workspace.getActiveFile();
    const sourceBasename = activeFile?.basename || "untitled";
    const label = annotation.label || "Untitled";
    const safeName = label.replace(/[\\/:*?"<>|]/g, "-");
    const folder = activeFile ? activeFile.parent?.path || "" : "";
    const basePath = folder ? `${folder}/${safeName}` : safeName;

    let md = `# ${label}\n\n`;
    md += `> ${annotation.excerpt}\n\n`;
    md += `Source: [[${sourceBasename}]]\n\n`;

    if (annotation.thread.messages.length > 0) {
      md += `## Thread\n\n`;
      for (const msg of annotation.thread.messages) {
        const msgText = getText(msg.content);
        md += `**${msg.role === "user" ? "You" : "AI"}**: ${msgText}\n`;
        for (const img of getImageParts(msg.content)) {
          md += `![[${img.vaultPath}]]\n`;
        }
        for (const doc of getDocumentParts(msg.content)) {
          md += `![[${doc.vaultPath}]]\n`;
        }
        md += `\n`;
      }
    }

    const nonEmptyBranches = annotation.thread.branches.filter(b => b.messages.length > 0);
    if (nonEmptyBranches.length > 0) {
      md += `## Branches\n\n`;
      for (const branch of nonEmptyBranches) {
        const kindLabel = branch.kind === "fork"
          ? (branch.label || "Fork")
          : "Regenerate";
        md += `### ${kindLabel} (from message ${branch.parentMessageId.slice(0, 8)})\n\n`;
        for (const msg of branch.messages) {
          const msgText = getText(msg.content);
          md += `**${msg.role === "user" ? "You" : "AI"}**: ${msgText}\n`;
          for (const img of getImageParts(msg.content)) {
            md += `![[${img.vaultPath}]]\n`;
          }
          for (const doc of getDocumentParts(msg.content)) {
            md += `![[${doc.vaultPath}]]\n`;
          }
          md += `\n`;
        }
      }
    }

    let exportPath = `${basePath}.md`;
    try {
      await this.app.vault.create(exportPath, md);
    } catch {
      exportPath = `${basePath}-${Date.now()}.md`;
      await this.app.vault.create(exportPath, md);
    }
    new Notice(`Exported to ${exportPath}`);
    return exportPath;
  }

  async exportAnnotations(format: "json" | "markdown" | "wikilinks"): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file to export annotations from.");
      return;
    }

    const annotations = this.store.getForFile(activeFile.path);
    if (annotations.length === 0) {
      new Notice("No annotations to export.");
      return;
    }

    const sorted = [...annotations].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    if (format === "json") {
      const json = JSON.stringify({ file: activeFile.path, annotations: sorted }, null, 2);
      const exportPath = activeFile.path.replace(/\.md$/, "") + "-annotations.json";
      await this.app.vault.create(exportPath, json);
      new Notice(`Exported to ${exportPath}`);
    } else if (format === "markdown") {
      let md = `# Annotations for ${activeFile.basename}\n\n`;
      for (const [i, ann] of sorted.entries()) {
        md += `## ${i + 1}. ${ann.label || "Untitled"}\n\n`;
        md += `> ${ann.excerpt}\n\n`;
        if (this.settings.exportIncludeThreads && ann.thread.messages.length > 0) {
          md += `### Thread\n\n`;
          for (const msg of ann.thread.messages) {
            const msgText = getText(msg.content);
            md += `**${msg.role === "user" ? "You" : "AI"}**: ${msgText}\n`;
            for (const img of getImageParts(msg.content)) {
              md += `![[${img.vaultPath}]]\n`;
            }
            for (const doc of getDocumentParts(msg.content)) {
              md += `![[${doc.vaultPath}]]\n`;
            }
            md += `\n`;
          }
        }
        if (this.settings.exportIncludeBranches) {
          const nonEmptyBranches = ann.thread.branches.filter(b => b.messages.length > 0);
          if (nonEmptyBranches.length > 0) {
            md += `### Branches\n\n`;
            for (const branch of nonEmptyBranches) {
              const kindLabel = branch.kind === "fork"
                ? (branch.label || "Fork")
                : "Regenerate";
              md += `#### ${kindLabel} (from message ${branch.parentMessageId.slice(0, 8)})\n\n`;
              for (const msg of branch.messages) {
                const msgText = getText(msg.content);
                md += `**${msg.role === "user" ? "You" : "AI"}**: ${msgText}\n`;
                for (const img of getImageParts(msg.content)) {
                  md += `![[${img.vaultPath}]]\n`;
                }
                for (const doc of getDocumentParts(msg.content)) {
                  md += `![[${doc.vaultPath}]]\n`;
                }
                md += `\n`;
              }
            }
          }
        }
        md += `---\n\n`;
      }
      const exportPath = activeFile.path.replace(/\.md$/, "") + "-annotations.md";
      await this.app.vault.create(exportPath, md);
      new Notice(`Exported to ${exportPath}`);
    } else if (format === "wikilinks") {
      const links = sorted.map((ann, i) => {
        const label = ann.label || `Annotation ${i + 1}`;
        const uri = `obsidian://annotator?id=${encodeURIComponent(ann.id)}&file=${encodeURIComponent(activeFile.path)}`;
        return `[${label}](${uri})`;
      });
      await navigator.clipboard.writeText(links.join("\n"));
      new Notice("Annotation links copied to clipboard.");
    }
  }
}

interface ConfirmModalOptions {
  title: string;
  body: string;
  confirmText: string;
  cancelText: string;
  destructive?: boolean;
  onResolve: (confirmed: boolean) => void;
}

/** Minimal yes/no modal used for destructive confirmations. */
class ConfirmModal extends Modal {
  private readonly opts: ConfirmModalOptions;
  private resolved = false;

  constructor(app: App, opts: ConfirmModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);
    contentEl.createEl("p", { text: this.opts.body });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelBtn = buttonRow.createEl("button", { text: this.opts.cancelText });
    cancelBtn.addEventListener("click", () => {
      this.resolve(false);
      this.close();
    });

    const confirmBtn = buttonRow.createEl("button", { text: this.opts.confirmText });
    confirmBtn.addClass("mod-cta");
    if (this.opts.destructive) confirmBtn.addClass("mod-warning");
    confirmBtn.addEventListener("click", () => {
      this.resolve(true);
      this.close();
    });
    confirmBtn.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    // If the user dismissed the modal without clicking a button, treat as cancel.
    this.resolve(false);
  }

  private resolve(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.opts.onResolve(value);
  }
}
