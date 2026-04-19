import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Annotation } from "../types";

export interface HighlightInfo {
  id: string;
  from: number;
  to: number;
  color: string;
  number: number;
}

export const setHighlights = StateEffect.define<HighlightInfo[]>();

class HighlightBadgeWidget extends WidgetType {
  private info: HighlightInfo;

  constructor(info: HighlightInfo) {
    super();
    this.info = info;
  }

  eq(other: HighlightBadgeWidget): boolean {
    return this.info.id === other.info.id && this.info.number === other.info.number;
  }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = `annotator-badge annotator-badge-${this.info.color}`;
    badge.textContent = String(this.info.number);
    badge.dataset.annotationId = this.info.id;
    badge.setAttribute("aria-label", `Annotation ${this.info.number}`);
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    return badge;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(decorations, tr) {
    decorations = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(setHighlights)) {
        const ranges: Range<Decoration>[] = [];

        for (const info of effect.value) {
          if (info.from >= 0 && info.to <= tr.state.doc.length && info.from < info.to) {
            ranges.push(
              Decoration.mark({
                class: `annotator-hl annotator-hl-${info.color}`,
                attributes: { "data-annotation-id": info.id },
                inclusiveStart: false,
                inclusiveEnd: false,
              }).range(info.from, info.to)
            );
            ranges.push(
              Decoration.widget({
                widget: new HighlightBadgeWidget(info),
                // side: -1 attaches the badge to the end of the highlight; text
                // inserted at this position appears AFTER the badge (not pushing
                // it with the cursor).
                side: -1,
              }).range(info.to)
            );
          }
        }

        // Sort by from position (required by RangeSet)
        ranges.sort((a, b) => a.from - b.from || a.to - b.to);
        decorations = RangeSet.of(ranges, true);
      }
    }

    return decorations;
  },

  provide(field) {
    return EditorView.decorations.from(field);
  },
});

export function createHighlightExtension(): typeof highlightField {
  return highlightField;
}

/**
 * CM6 update listener that keeps the annotation store's stored offsets in
 * sync with the document as the user edits. Without this, highlights shift
 * visually (via decorations.map) but the stored `from`/`to` remain stale,
 * so the next setHighlights dispatch overwrites the mapped positions with
 * the old ones — causing highlights to drift back.
 */
export function createHighlightPositionSync(
  getFilePath: () => string | null,
  onPositionsChanged: (
    filePath: string,
    updates: Array<{ id: string; from: number; to: number }>
  ) => void
): ReturnType<typeof EditorView.updateListener.of> {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const filePath = getFilePath();
    if (!filePath) return;

    const decorations = update.state.field(highlightField, false);
    if (!decorations) return;

    const updates: Array<{ id: string; from: number; to: number }> = [];
    const seen = new Set<string>();
    decorations.between(0, update.state.doc.length, (from, to, decoration) => {
      const spec = decoration.spec as { attributes?: { [key: string]: string } };
      const id = spec.attributes?.["data-annotation-id"];
      if (id && !seen.has(id)) {
        seen.add(id);
        updates.push({ id, from, to });
      }
    });

    if (updates.length > 0) {
      onPositionsChanged(filePath, updates);
    }
  });
}

/**
 * Creates a CM6 extension that fires a callback when the user clicks
 * on a highlight span or badge in the editor.
 */
export function createHighlightClickHandler(
  onClickAnnotation: (annotationId: string) => void
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    click(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const annotationEl = target.closest<HTMLElement>(
        ".annotator-hl, .annotator-badge"
      );
      if (!annotationEl) return false;

      const id = annotationEl.dataset.annotationId;
      if (id) {
        onClickAnnotation(id);
        return true;
      }
      return false;
    },
  });
}
