import { TFile, normalizePath } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { Annotation, AnnotationData, Thread, ThreadMessage, ThreadBranch } from "../types";
import { DATA_VERSION } from "../constants";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class AnnotationStore {
  private data: Map<string, Annotation[]> = new Map();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private plugin: AnnotatorPlugin;

  constructor(plugin: AnnotatorPlugin) {
    this.plugin = plugin;
  }

  async load(): Promise<void> {
    const raw = await this.plugin.loadData();
    if (raw?.annotations) {
      const parsed = raw as AnnotationData;
      this.data.clear();
      for (const ann of parsed.annotations) {
        // Migrate old messages missing contextNoteRefs
        for (const msg of ann.thread.messages) {
          msg.contextNoteRefs ??= [];
        }
        // Migrate threads missing activeBranchByParent
        if (!ann.thread.activeBranchByParent) {
          ann.thread.activeBranchByParent = {};
        }
        // Migrate threads missing branches (pre-branching data)
        if (!ann.thread.branches) {
          ann.thread.branches = [];
        }
        // Migrate legacy branches missing kind / createdAt
        for (const branch of ann.thread.branches) {
          if (!branch.kind) branch.kind = "fork";
          if (!branch.createdAt) branch.createdAt = new Date().toISOString();
        }
        // Strip dead Thread.provider field from legacy data
        delete (ann.thread as any).provider;
        delete (ann as any).attachments;
        const existing = this.data.get(ann.fileVaultPath) || [];
        existing.push(ann);
        this.data.set(ann.fileVaultPath, existing);
      }
    }
  }

  async save(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    const allAnnotations: Annotation[] = [];
    for (const anns of this.data.values()) {
      allAnnotations.push(...anns);
    }
    // Preserve existing plugin data (settings, etc.) when saving annotations
    const existing = (await this.plugin.loadData()) || {};
    await this.plugin.saveData({
      ...existing,
      annotations: allAnnotations,
      version: DATA_VERSION,
    });
  }

  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(), 2000);
  }

  getAll(): Annotation[] {
    const all: Annotation[] = [];
    for (const anns of this.data.values()) {
      all.push(...anns);
    }
    return all;
  }

  getForFile(path: string): Annotation[] {
    return this.data.get(path) || [];
  }

  getById(id: string): Annotation | undefined {
    for (const anns of this.data.values()) {
      const found = anns.find(a => a.id === id);
      if (found) return found;
    }
    return undefined;
  }

  getAnnotationNumber(annotation: Annotation): number {
    const fileAnns = this.getForFile(annotation.fileVaultPath);
    const sorted = [...fileAnns].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return sorted.findIndex(a => a.id === annotation.id) + 1;
  }

  createAnnotation(
    filePath: string,
    excerpt: string,
    from: number,
    to: number,
    color?: string
  ): Annotation {
    const now = new Date().toISOString();
    const id = generateId();
    const annotation: Annotation = {
      id,
      fileVaultPath: filePath,
      label: excerpt.length > 60 ? excerpt.slice(0, 60).trimEnd() + "\u2026" : excerpt,
      color: (color as Annotation["color"]) || this.plugin.settings.defaultColor,
      excerpt,
      from,
      to,
      createdAt: now,
      updatedAt: now,
      linkedAnnotations: [],
      thread: {
        id: generateId(),
        messages: [],
        branches: [],
        activeBranchByParent: {},
      },
    };

    const existing = this.data.get(filePath) || [];
    existing.push(annotation);
    this.data.set(filePath, existing);
    this.scheduleSave();
    this.plugin.onAnnotationsChanged(filePath);
    return annotation;
  }

  updateAnnotation(id: string, partial: Partial<Annotation>): void {
    for (const [path, anns] of this.data.entries()) {
      const idx = anns.findIndex(a => a.id === id);
      if (idx !== -1) {
        anns[idx] = { ...anns[idx], ...partial, updatedAt: new Date().toISOString() };
        this.scheduleSave();
        this.plugin.onAnnotationsChanged(path);
        return;
      }
    }
  }

  deleteAnnotation(id: string): void {
    for (const [path, anns] of this.data.entries()) {
      const idx = anns.findIndex(a => a.id === id);
      if (idx !== -1) {
        anns.splice(idx, 1);
        if (anns.length === 0) {
          this.data.delete(path);
        }
        this.scheduleSave();
        this.plugin.onAnnotationsChanged(path);
        return;
      }
    }
  }

  addMessage(annotationId: string, message: ThreadMessage): void {
    const ann = this.getById(annotationId);
    if (!ann) return;
    ann.thread.messages.push(message);
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  createFork(annotationId: string, fromMessageId: string): ThreadBranch | undefined {
    const ann = this.getById(annotationId);
    if (!ann) return undefined;
    const forkCount = ann.thread.branches.filter(b => b.kind === "fork").length;
    const branch: ThreadBranch = {
      id: generateId(),
      parentMessageId: fromMessageId,
      messages: [],
      kind: "fork",
      createdAt: new Date().toISOString(),
      label: `Fork ${forkCount + 1}`,
    };
    ann.thread.branches.push(branch);
    ann.thread.activeBranchByParent[fromMessageId] = branch.id;
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return branch;
  }

  createRegenerate(annotationId: string, parentUserMessageId: string): ThreadBranch | undefined {
    const ann = this.getById(annotationId);
    if (!ann) return undefined;
    const branch: ThreadBranch = {
      id: generateId(),
      parentMessageId: parentUserMessageId,
      messages: [],
      kind: "regenerate",
      createdAt: new Date().toISOString(),
    };
    ann.thread.branches.push(branch);
    ann.thread.activeBranchByParent[parentUserMessageId] = branch.id;
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return branch;
  }

  addMessageToBranch(annotationId: string, branchId: string, message: ThreadMessage): void {
    const ann = this.getById(annotationId);
    if (!ann) return;
    const branch = ann.thread.branches.find(b => b.id === branchId);
    if (!branch) return;
    branch.messages.push(message);
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  setActiveBranch(annotationId: string, parentMessageId: string, branchId: string | null): void {
    const ann = this.getById(annotationId);
    if (!ann) return;
    if (branchId === null) {
      delete ann.thread.activeBranchByParent[parentMessageId];
    } else {
      ann.thread.activeBranchByParent[parentMessageId] = branchId;
    }
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  renameBranch(annotationId: string, branchId: string, label: string): void {
    const ann = this.getById(annotationId);
    if (!ann) return;
    const branch = ann.thread.branches.find(b => b.id === branchId);
    if (!branch || branch.kind !== "fork") return;
    branch.label = label;
    ann.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  onFileRename(oldPath: string, newPath: string): void {
    const anns = this.data.get(oldPath);
    if (!anns) return;
    this.data.delete(oldPath);
    for (const ann of anns) {
      ann.fileVaultPath = newPath;
    }
    this.data.set(newPath, anns);
    this.scheduleSave();
  }

  /** Update stored offsets for a file — called when CM6 positions change */
  updatePositions(filePath: string, updates: Array<{ id: string; from: number; to: number }>): void {
    const anns = this.data.get(filePath);
    if (!anns) return;
    for (const upd of updates) {
      const ann = anns.find(a => a.id === upd.id);
      if (ann) {
        ann.from = upd.from;
        ann.to = upd.to;
      }
    }
    this.scheduleSave();
  }
}
