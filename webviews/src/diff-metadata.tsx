import type { DiffViewerLabelResolver } from "./labels";
import { hunkIdentityIDs } from "./hunk-identity";

export type DiffMetadataKind = "binary" | "mode";

export type CmuxHunkMetadata = {
  cmuxHunkId: string;
  cmuxHunkNumber: number;
};

/**
 * Keeps Full File context state independent from Pierre's transient hunk
 * indexes. The ID is semantic and therefore survives a regenerated diff.
 */
export function toggleExpandedHunkID(
  expandedHunkIDs: ReadonlySet<string>,
  hunkID: string,
): ReadonlySet<string> {
  const next = new Set(expandedHunkIDs);
  if (next.has(hunkID)) {
    next.delete(hunkID);
  } else {
    next.add(hunkID);
  }
  return next;
}

/** Keeps semantically identical aggregate hunks independent by rendered item. */
export function scopedHunkID(itemId: string, hunkId: string): string {
  return `${itemId}\u0000${hunkId}`;
}

/** Full File is expanded by default; this set records only explicit collapses. */
export function fullFileHunkIsExpanded(
  collapsedHunkIDs: ReadonlySet<string>,
  itemId: string,
  hunkId: string,
): boolean {
  return !collapsedHunkIDs.has(scopedHunkID(itemId, hunkId));
}

export function annotateDiffMetadata(fileDiff: any, patchText?: string): void {
  if (fileDiff == null || typeof fileDiff !== "object") {
    return;
  }
  const hunks = Array.isArray(fileDiff.hunks) ? fileDiff.hunks : [];
  annotateHunks(fileDiff, hunks);
  const hasBinaryMarker = patchText != null && /(?:^|\n)(?:GIT binary patch|Binary files .* differ)(?:\n|$)/.test(patchText);
  const isParsedBinary = fileDiff.type === "change" && hunks.length === 0 &&
    typeof fileDiff.prevObjectId === "string" && typeof fileDiff.newObjectId === "string" &&
    fileDiff.prevMode == null;
  if (hasBinaryMarker || isParsedBinary) {
    fileDiff.cmuxDiffMetadataKind = "binary" satisfies DiffMetadataKind;
  } else if (typeof fileDiff.prevMode === "string" && typeof fileDiff.mode === "string" && fileDiff.prevMode !== fileDiff.mode) {
    fileDiff.cmuxDiffMetadataKind = "mode" satisfies DiffMetadataKind;
  }
}

/** Assigns deterministic per-file identities before the diff enters CodeView. */
export function annotateHunks(fileDiff: any, hunks: any[] = fileDiff?.hunks ?? []): void {
  const path = String(fileDiff?.name ?? fileDiff?.newName ?? fileDiff?.oldName ?? "");
  const ids = hunkIdentityIDs({
    filePath: path,
    hunks,
    additionLines: fileDiff?.additionLines,
    deletionLines: fileDiff?.deletionLines,
  });
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (hunk == null || typeof hunk !== "object") continue;
    hunk.cmuxHunkId = ids[index];
    hunk.cmuxHunkNumber = index + 1;
  }
}

export function resolveDiffHeaderMetadata(fileDiff: any, label: DiffViewerLabelResolver): string | undefined {
  if (fileDiff?.cmuxDiffMetadataKind === "binary") {
    return label("binaryFile");
  }
  if (fileDiff?.cmuxDiffMetadataKind === "mode") {
    return label("modeChange")
      .replace("{old}", fileDiff.prevMode ?? "")
      .replace("{new}", fileDiff.mode ?? "");
  }
  return undefined;
}

export function DiffHeaderMetadata({
  fileDiff,
  label,
  repositoryBaseRef,
  repositoryLabel,
  repositoryRoot,
  repositoryStart,
  hunkScope,
  collapsedHunkIDs,
  fullFile,
  onExpandHunk,
}: {
  fileDiff: any;
  label: DiffViewerLabelResolver;
  repositoryBaseRef?: string;
  repositoryLabel?: string;
  repositoryRoot?: string;
  repositoryStart?: boolean;
  hunkScope?: string;
  collapsedHunkIDs?: ReadonlySet<string>;
  fullFile?: boolean;
  onExpandHunk?: (hunkIndex: number, hunkId: string) => void;
}) {
  const metadata = resolveDiffHeaderMetadata(fileDiff, label);
  if (metadata == null && repositoryLabel == null && !fullFile) {
    return null;
  }
  return (
    <span data-cmux-diff-metadata={fileDiff.cmuxDiffMetadataKind ?? "repository"}>
      {repositoryLabel != null ? (
        <span data-cmux-review-repository={repositoryStart ? "section" : "file"} title={repositoryRoot}>
          {label("repository")}: {repositoryLabel}{repositoryBaseRef ? ` · ${label("branchBase")}: ${repositoryBaseRef}` : ""}
        </span>
      ) : null}
      {metadata != null && repositoryLabel != null ? " · " : null}
      {metadata}
      {fullFile ? <span data-cmux-full-file-hunks>{(fileDiff?.hunks ?? []).map((hunk: any, index: number) => {
        const hunkId = hunk?.cmuxHunkId;
        if (typeof hunkId !== "string") return null;
        const expanded = hunkScope == null
          ? !(collapsedHunkIDs?.has(hunkId) ?? false)
          : fullFileHunkIsExpanded(collapsedHunkIDs ?? new Set(), hunkScope, hunkId);
        return (
          <button
            key={hunkId}
            type="button"
            data-cmux-full-file-hunk={hunkId}
            aria-pressed={expanded}
            title={expanded ? label("collapseUnchangedContext") : label("expandUnchangedContext")}
            onClick={() => onExpandHunk?.(index, hunkId)}
          >
            {expanded ? `✓ ${hunk.cmuxHunkNumber}` : hunk.cmuxHunkNumber}
          </button>
        );
      })}</span> : null}
    </span>
  );
}

/**
 * Adds the stable per-file hunk number to Pierre's rendered gutter. This runs
 * only for virtualized, mounted items; it never asks Pierre to materialize
 * offscreen hunks.
 */
export function decorateRenderedHunkGutters(root: HTMLElement, fileDiff: any): void {
  const hunks = Array.isArray(fileDiff?.hunks) ? fileDiff.hunks : [];
  if (hunks.length === 0) return;
  for (const renderRoot of shadowRoots(root)) {
    for (const hunk of hunks) {
      const number = hunk?.cmuxHunkNumber;
      const line = positiveLine(hunk?.additionStart) ?? positiveLine(hunk?.deletionStart);
      if (!Number.isInteger(number) || line == null) continue;
      const target = renderRoot.querySelector<HTMLElement>(`[data-column-number="${line}"]`);
      if (target == null || target.querySelector(`[data-cmux-hunk-badge="${number}"]`) != null) continue;
      const badge = target.ownerDocument.createElement("span");
      badge.dataset.cmuxHunkBadge = String(number);
      badge.textContent = String(number);
      badge.setAttribute("aria-hidden", "true");
      target.append(badge);
    }
  }
}

function shadowRoots(root: HTMLElement): (Document | ShadowRoot | HTMLElement)[] {
  const result: (Document | ShadowRoot | HTMLElement)[] = [root];
  for (const child of root.querySelectorAll<HTMLElement>("*")) {
    if (child.shadowRoot != null) result.push(child.shadowRoot);
  }
  return result;
}

function positiveLine(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
