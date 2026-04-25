import { StateField } from "@codemirror/state";
import { showTooltip, EditorView } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import { HIGHLIGHT_COLORS } from "../constants";
import type { HighlightColor } from "../types";
import type AnnotatorPlugin from "../main";

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
  void plugin.openChatForAnnotation(annotation);
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
          const dom = createDiv({ cls: "annotator-selection-menu" });

          for (const color of HIGHLIGHT_COLORS) {
            const btn = dom.createEl("button", {
              cls: `annotator-color-btn annotator-color-btn-${color}`,
              attr: {
                "aria-label": `Annotate with ${color}`,
                "data-tooltip-position": "top",
              },
            });
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              createAnnotationFromSelection(plugin, view, color);
            });
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
