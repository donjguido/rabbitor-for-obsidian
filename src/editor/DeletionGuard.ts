import { EditorState, Annotation as CMAnnotation } from "@codemirror/state";
import type { Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { highlightField } from "./HighlightExtension";

/**
 * A transaction annotation that tells the deletion guard to skip its checks.
 * Used when re-dispatching a previously-blocked transaction after the user
 * has confirmed the deletion in the warning modal.
 */
export const bypassDeletionGuard = CMAnnotation.define<boolean>();

export interface DeletionGuardDeps {
  /** Returns annotation ids that, if deleted, require a confirmation prompt. */
  filterWarnable: (collapsedIds: string[]) => string[];
  /** Called to prompt the user. Must resolve `true` to proceed with deletion. */
  confirmDeletion: (warnableIds: string[]) => Promise<boolean>;
  /** Called after a transaction collapses highlights (silently or after confirm). */
  onCollapsed: (collapsedIds: string[]) => void;
}

/** Inspect a transaction and return annotation ids whose ranges fully collapse. */
function findCollapsingAnnotationIds(tr: Transaction): string[] {
  const decorations = tr.startState.field(highlightField, false);
  if (!decorations) return [];

  const collapsing: string[] = [];
  decorations.between(0, tr.startState.doc.length, (from, to, dec) => {
    // Only mark decorations (with attributes) represent the highlight range;
    // badge widgets share the "to" position but have no attributes.
    const spec = dec.spec as { attributes?: { [key: string]: string } };
    const id = spec.attributes?.["data-annotation-id"];
    if (!id) return;

    // Map each endpoint INWARD (from with +1 assoc, to with -1 assoc). If the
    // original range is fully contained in a deletion, both endpoints map to
    // the same position, giving newFrom >= newTo.
    const newFrom = tr.changes.mapPos(from, 1);
    const newTo = tr.changes.mapPos(to, -1);
    if (newFrom >= newTo && !collapsing.includes(id)) {
      collapsing.push(id);
    }
  });
  return collapsing;
}

/**
 * A CM6 extension that intercepts transactions which would fully delete
 * highlighted text. If any affected annotation has chat history, the user
 * is prompted before the deletion is allowed through. Annotations without
 * chat history are cleaned up silently after the fact.
 */
export function createDeletionGuard(deps: DeletionGuardDeps): Extension {
  // View tracker: the transactionFilter below only sees state, not view, so
  // we stash the view on the state field via a WeakMap keyed by the pre-tx
  // state. The ViewPlugin keeps the map populated.
  const viewByState = new WeakMap<EditorState, EditorView>();

  const tracker = ViewPlugin.define((view) => {
    viewByState.set(view.state, view);
    return {
      update(update: ViewUpdate) {
        viewByState.set(update.state, view);
      },
    };
  });

  const filter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (tr.annotation(bypassDeletionGuard)) return tr;

    const collapsing = findCollapsingAnnotationIds(tr);
    if (collapsing.length === 0) return tr;

    const warnable = deps.filterWarnable(collapsing);
    if (warnable.length === 0) {
      // Silent path — the cleanup listener below will remove these annotations
      // after the transaction commits.
      return tr;
    }

    // Warning path — block the transaction, prompt, and re-dispatch on confirm.
    const view = viewByState.get(tr.startState);
    if (!view) {
      // Can't re-dispatch without a view; fall back to letting the deletion
      // through so the user's edit isn't silently dropped.
      return tr;
    }

    const changes = tr.changes;
    const selection = tr.selection;
    void deps.confirmDeletion(warnable).then((confirmed) => {
      if (!confirmed) return;
      view.dispatch({
        changes,
        selection,
        annotations: bypassDeletionGuard.of(true),
      });
    });
    return [];
  });

  const cleanup = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    // Find ids whose ranges collapsed in any of this update's transactions.
    const collapsedIds = new Set<string>();
    for (const tr of update.transactions) {
      for (const id of findCollapsingAnnotationIds(tr)) {
        collapsedIds.add(id);
      }
    }
    if (collapsedIds.size > 0) {
      deps.onCollapsed(Array.from(collapsedIds));
    }
  });

  return [tracker, filter, cleanup];
}
