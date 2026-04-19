import type { Thread, ThreadMessage, ThreadBranch } from "../types";

/** Walk the thread's active path given activeBranchByParent.
 *  For each message, check if activeBranchByParent has an entry. If so,
 *  switch into that branch's messages and restart iteration. Fork and
 *  regenerate both use the same mechanism: the branch's messages replace
 *  whatever came after the parent on the previous sequence. */
export function getActivePath(thread: Thread): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  let seq: ThreadMessage[] = thread.messages;
  let i = 0;
  // Safety cap in case of circular branch references (shouldn't happen
  // normally, but avoids infinite loops on corrupted data).
  let safety = 10_000;
  while (i < seq.length && safety-- > 0) {
    const msg = seq[i];
    result.push(msg);
    const activeChildId = thread.activeBranchByParent[msg.id];
    if (activeChildId) {
      const branch = thread.branches.find(b => b.id === activeChildId);
      if (branch) {
        seq = branch.messages;
        i = 0;
        continue;
      }
    }
    i++;
  }
  return result;
}

/** Return all regenerate branches whose parent is the user message immediately
 *  before the given assistant message on the active path. Sorted by createdAt
 *  ascending. Returns null if the given index does not point to an assistant
 *  message preceded by a user message. */
export function getRegenerateSiblings(
  thread: Thread,
  path: ThreadMessage[],
  assistantMsgIndex: number
): { parentUserMsgId: string; branches: ThreadBranch[] } | null {
  if (assistantMsgIndex <= 0) return null;
  const assistantMsg = path[assistantMsgIndex];
  if (!assistantMsg || assistantMsg.role !== "assistant") return null;
  const parent = path[assistantMsgIndex - 1];
  if (!parent || parent.role !== "user") return null;
  const siblings = thread.branches
    .filter(b => b.kind === "regenerate" && b.parentMessageId === parent.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { parentUserMsgId: parent.id, branches: siblings };
}

/** Return the 1-based active index and total count for the regenerate
 *  siblings of a given assistant message. Index 1 = original reply;
 *  2..N = regenerate branches in createdAt order. Returns null if no
 *  regenerate siblings exist. */
export function getRegenerateNavState(
  thread: Thread,
  path: ThreadMessage[],
  assistantMsgIndex: number
): { active: number; total: number; parentUserMsgId: string } | null {
  const sib = getRegenerateSiblings(thread, path, assistantMsgIndex);
  if (!sib || sib.branches.length === 0) return null;
  const total = sib.branches.length + 1; // +1 for the original reply
  const activeId = thread.activeBranchByParent[sib.parentUserMsgId];
  let active = 1; // 1 = original
  if (activeId) {
    const idx = sib.branches.findIndex(b => b.id === activeId);
    if (idx >= 0) active = idx + 2; // 2..N map to regenerate branches
  }
  return { active, total, parentUserMsgId: sib.parentUserMsgId };
}

/** Return all fork branches on this thread, sorted by createdAt ascending. */
export function getForkBranches(thread: Thread): ThreadBranch[] {
  return thread.branches
    .filter(b => b.kind === "fork")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
