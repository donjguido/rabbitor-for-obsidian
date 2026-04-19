import { StateField } from "@codemirror/state";
import { showTooltip, EditorView } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import { HIGHLIGHT_COLORS } from "../constants";
import type { HighlightColor } from "../types";
import type AnnotatorPlugin from "../main";

const COLOR_HEX: Record<HighlightColor, string> = {
  purple: "#a882ff",
  yellow: "#e0de71",
  blue: "#6cb6ff",
  green: "#6bce8a",
  pink: "#f17eb8",
  orange: "#e9973f",
  red: "#e5484d",
  teal: "#4ec9b0",
};

function createAnnotationFromSelection(plugin: AnnotatorPlugin, view: EditorView, color: string): void {
  const state = view.state;
  const sel = state.selection.main;
  if (sel.from === sel.to) return;
  const excerpt = state.sliceDoc(sel.from, sel.to);
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) return;
  const annotation = plugin.store.createAnnotation(
    activeFile.path,
    excerpt,
    sel.from,
    sel.to,
    color
  );
  // Clear selection after annotating so the tooltip disappears
  view.dispatch({ selection: { anchor: sel.to } });
  plugin.openChatForAnnotation(annotation);
}

export function createSelectionMenu(plugin: AnnotatorPlugin) {
  return StateField.define<readonly Tooltip[]>({
    create() {
      return [];
    },

    update(tooltips, tr) {
      if (!tr.selection) return tooltips;
      const { from, to } = tr.selection.main;
      if (from === to) return [];

      // When color picker is disabled, don't show the tooltip
      if (!plugin.settings.showColorPicker) return [];

      return [{
        pos: from,
        above: true,
        create(view: EditorView) {
          const dom = document.createElement("div");
          dom.className = "annotator-selection-menu";

          for (const color of HIGHLIGHT_COLORS) {
            const btn = document.createElement("button");
            btn.className = `annotator-color-btn`;
            btn.style.backgroundColor = COLOR_HEX[color];
            btn.setAttribute("aria-label", `Annotate with ${color}`);
            btn.setAttribute("data-tooltip-position", "top");
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              createAnnotationFromSelection(plugin, view, color);
            });
            dom.appendChild(btn);
          }

          return { dom };
        },
      }];
    },

    provide(field) {
      return showTooltip.computeN([field], (state) => state.field(field));
    },
  });
}
