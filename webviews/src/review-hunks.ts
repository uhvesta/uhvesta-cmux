import type { DiffItem } from "./diff-stream";

export type ReviewHunk = {
  filePath: string;
  hunkId: string;
  hunkIndex: number;
  itemId: string;
  repositoryRoot?: string;
  lineNumber: number;
  side: "additions" | "deletions";
};

export type ReviewCursor = {
  itemId: string;
  lineNumber: number;
  side: "additions" | "deletions";
};

/** Returns the stable, ordered review hunk cursor list for the current patch. */
export function reviewHunks(items: readonly DiffItem[]): ReviewHunk[] {
  const result: ReviewHunk[] = [];
  for (const item of items) {
    const fileDiff = item.fileDiff;
    const filePath = item.commentFilePath ?? (typeof fileDiff?.name === "string" ? fileDiff.name : item.id);
    const hunks = Array.isArray(fileDiff?.hunks) ? fileDiff.hunks : [];
    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex] ?? {};
      const additionLine = finiteLine(hunk.additionStart);
      const deletionLine = finiteLine(hunk.deletionStart);
      result.push({
        filePath,
        hunkId: typeof hunk.cmuxHunkId === "string" ? hunk.cmuxHunkId : `${filePath}:${hunkIndex}`,
        hunkIndex,
        itemId: item.id,
        repositoryRoot: item.commentRepoRoot,
        lineNumber: additionLine ?? deletionLine ?? 1,
        side: additionLine != null ? "additions" : "deletions",
      });
    }
  }
  return result;
}

/** Finds the next or previous hunk relative to the active review cursor. */
export function adjacentReviewHunk(
  hunks: readonly ReviewHunk[],
  cursor: ReviewCursor | null,
  direction: -1 | 1,
): ReviewHunk | null {
  if (hunks.length === 0) return null;
  if (cursor == null) return direction > 0 ? hunks[0]! : hunks.at(-1)!;
  const exactIndex = activeHunkIndex(hunks, cursor);
  if (exactIndex >= 0) {
    return hunks[Math.max(0, Math.min(hunks.length - 1, exactIndex + direction))] ?? null;
  }
  const itemIndex = hunks.findIndex((hunk) => hunk.itemId === cursor.itemId);
  if (itemIndex >= 0) {
    return direction > 0 ? hunks[itemIndex] ?? null : hunks[Math.max(0, itemIndex - 1)] ?? null;
  }
  return direction > 0 ? hunks[0]! : hunks.at(-1)!;
}

/** Resolves a native-provided one-based hunk request without trusting malformed input. */
export function requestedReviewHunk(
  items: readonly DiffItem[],
  request: unknown,
): ReviewHunk | null {
  const scoped = requestedReviewHunkScope(request);
  if (scoped != null) {
    const candidates = reviewHunks(items).filter((hunk) =>
      (scoped.file == null || hunk.filePath === scoped.file) &&
      (scoped.repoRoot == null || hunk.repositoryRoot === scoped.repoRoot),
    );
    return candidates[scoped.number - 1] ?? null;
  }
  const hunkNumber = typeof request === "number"
    ? request
    : typeof request === "string" && /^\d+$/.test(request) ? Number(request) : null;
  if (!Number.isInteger(hunkNumber) || hunkNumber == null || hunkNumber < 1) return null;
  return reviewHunks(items)[hunkNumber - 1] ?? null;
}

function requestedReviewHunkScope(request: unknown): { file?: string; number: number; repoRoot?: string } | null {
  if (request == null || typeof request !== "object" || Array.isArray(request)) return null;
  const value = request as Record<string, unknown>;
  const rawNumber = value.hunk ?? value.number;
  const number = typeof rawNumber === "number" ? rawNumber : typeof rawNumber === "string" && /^\d+$/.test(rawNumber) ? Number(rawNumber) : null;
  if (!Number.isInteger(number) || number == null || number < 1) return null;
  const file = typeof value.file === "string" && value.file.trim() !== "" ? value.file : undefined;
  const repoRoot = typeof value.repoRoot === "string" && value.repoRoot.trim() !== "" ? value.repoRoot : undefined;
  return file != null || repoRoot != null ? { file, number, repoRoot } : null;
}

/** Builds a draft cursor from a clicked line, falling back to the hunk's new side. */
export function cursorForHunk(hunk: ReviewHunk): ReviewCursor {
  return { itemId: hunk.itemId, lineNumber: hunk.lineNumber, side: hunk.side };
}

function finiteLine(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function activeHunkIndex(hunks: readonly ReviewHunk[], cursor: ReviewCursor): number {
  let active = -1;
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index]!;
    if (hunk.itemId === cursor.itemId && hunk.side === cursor.side && hunk.lineNumber <= cursor.lineNumber) {
      active = index;
    }
  }
  return active;
}
