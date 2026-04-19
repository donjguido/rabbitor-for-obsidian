import type { MarkdownPostProcessorContext } from "obsidian";
import type AnnotatorPlugin from "../main";
import type { Annotation } from "../types";

/**
 * Creates a markdown post-processor that wraps annotation excerpts with
 * highlight spans + numbered badges when a note is rendered in reading mode
 * (and in other rendered contexts like embedded previews).
 *
 * Annotation offsets (`from`/`to`) are character positions in the raw
 * markdown source, but reading mode renders to HTML where those offsets
 * don't map directly (markdown syntax is stripped, links are transformed,
 * etc.). We match by the stored `excerpt` text instead.
 *
 * When `ctx.getSectionInfo(el)` is available, we use it to restrict each
 * block to only the annotations whose source range overlaps that block.
 * This avoids wrapping an excerpt in the wrong block when multiple blocks
 * share the same text.
 */
export function createReadingModeProcessor(
  plugin: AnnotatorPlugin
): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
  return (el, ctx) => {
    const annotations = plugin.store.getForFile(ctx.sourcePath);
    if (annotations.length === 0) return;

    // Build the stable ordering used everywhere else for badge numbering
    // (creation order).
    const sorted = [...annotations].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Compute per-section range if possible, so we only wrap annotations
    // that actually live in this block.
    const sectionRange = computeSectionRange(el, ctx);

    for (let i = 0; i < sorted.length; i++) {
      const ann = sorted[i];
      if (sectionRange && !overlaps(ann, sectionRange)) continue;
      wrapFirstMatch(el, ann, i + 1, plugin);
    }
  };
}

interface SectionRange {
  start: number;
  end: number;
}

function computeSectionRange(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext
): SectionRange | null {
  const info = ctx.getSectionInfo(el);
  if (!info) return null;
  const lines = info.text.split("\n");
  let start = 0;
  for (let i = 0; i < info.lineStart && i < lines.length; i++) {
    start += lines[i].length + 1; // +1 for the "\n"
  }
  let end = start;
  for (let i = info.lineStart; i <= info.lineEnd && i < lines.length; i++) {
    end += lines[i].length + 1;
  }
  return { start, end };
}

function overlaps(ann: Annotation, range: SectionRange): boolean {
  return ann.from < range.end && ann.to > range.start;
}

/**
 * Walks text nodes under `root`, finds the first occurrence of
 * `ann.excerpt`, and wraps it in a highlight span followed by a badge.
 * Text nodes inside an already-wrapped highlight are skipped so a second
 * annotation with an overlapping excerpt doesn't double-wrap.
 */
function wrapFirstMatch(
  root: HTMLElement,
  ann: Annotation,
  number: number,
  plugin: AnnotatorPlugin
): boolean {
  const excerpt = ann.excerpt;
  if (!excerpt) return false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement;
      if (parent && parent.closest(".annotator-hl")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const text = textNode.nodeValue ?? "";
    const idx = text.indexOf(excerpt);
    if (idx < 0) continue;

    const parent = textNode.parentNode;
    if (!parent) return false;

    const before = text.slice(0, idx);
    const after = text.slice(idx + excerpt.length);

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));

    const hl = document.createElement("span");
    hl.className = `annotator-hl annotator-hl-${ann.color}`;
    hl.dataset.annotationId = ann.id;
    hl.textContent = excerpt;
    frag.appendChild(hl);

    const badge = document.createElement("span");
    badge.className = `annotator-badge annotator-badge-${ann.color}`;
    badge.textContent = String(number);
    badge.dataset.annotationId = ann.id;
    badge.setAttribute("aria-label", `Annotation ${number}`);
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    frag.appendChild(badge);

    if (after) frag.appendChild(document.createTextNode(after));

    const openChat = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const annotation = plugin.store.getById(ann.id);
      if (!annotation) return;
      void plugin.activateView().then(() => {
        plugin.getAnnotatorView()?.selectAnnotation(annotation);
      });
    };
    hl.addEventListener("click", openChat);
    badge.addEventListener("click", openChat);
    badge.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") openChat(e);
    });

    parent.replaceChild(frag, textNode);
    return true;
  }
  return false;
}
