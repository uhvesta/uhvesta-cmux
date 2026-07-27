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

/**
 * Produces the compact Pierre input for explicitly collapsed Full File hunks.
 *
 * The source diff stays untouched: it is the durable source for h/l navigation
 * and semantic hunk IDs. Pierre only supports expanding collapsed inter-hunk
 * regions, so a fully-expanded Git patch needs its selected hunk context
 * represented as those regions before Pierre can render it collapsed again.
 */
export function fullFileDiffWithCollapsedHunks(
  fileDiff: any,
  itemId: string,
  collapsedHunkIDs: ReadonlySet<string>,
): any {
  const sourceHunks = Array.isArray(fileDiff?.hunks) ? fileDiff.hunks : [];
  if (sourceHunks.length === 0 || !hasCompleteFileContents(fileDiff, sourceHunks)) return fileDiff;
  const hasCollapsedHunk = sourceHunks.some((hunk: any) => (
    typeof hunk?.cmuxHunkId === "string" &&
    collapsedHunkIDs.has(scopedHunkID(itemId, hunk.cmuxHunkId))
  ));
  if (!hasCollapsedHunk) return fileDiff;

  const hunks: any[] = [];
  for (const sourceHunk of sourceHunks) {
    const hunkId = sourceHunk?.cmuxHunkId;
    if (typeof hunkId !== "string" || !collapsedHunkIDs.has(scopedHunkID(itemId, hunkId))) {
      hunks.push({ ...sourceHunk, hunkContent: [...(sourceHunk.hunkContent ?? [])] });
      continue;
    }
    const compactHunks = compactHunkContext(sourceHunk);
    // A malformed hunk with no change cannot be compacted without losing its
    // only content, so leave it visible.
    hunks.push(...(compactHunks.length > 0 ? compactHunks : [{ ...sourceHunk, hunkContent: [...(sourceHunk.hunkContent ?? [])] }]));
  }
  return layoutCompactHunks(fileDiff, hunks);
}

function hasCompleteFileContents(fileDiff: any, hunks: any[]): boolean {
  const covers = (lines: unknown, startKey: string, countKey: string): boolean => {
    const lineCount = Array.isArray(lines) ? lines.length : 0;
    if (lineCount === 0) return true;
    let coveredThrough = 0;
    for (const hunk of hunks) {
      const start = Number(hunk?.[startKey]);
      const count = Number(hunk?.[countKey]);
      if (!Number.isFinite(start) || !Number.isFinite(count) || start > coveredThrough + 1) return false;
      coveredThrough = Math.max(coveredThrough, start + Math.max(count, 0) - 1);
    }
    return coveredThrough >= lineCount;
  };
  return covers(fileDiff?.additionLines, "additionStart", "additionCount")
    && covers(fileDiff?.deletionLines, "deletionStart", "deletionCount");
}

function compactHunkContext(sourceHunk: any): any[] {
  const content = Array.isArray(sourceHunk?.hunkContent) ? sourceHunk.hunkContent : [];
  const finalContent = content.at(-1);
  return content.flatMap((part: any) => {
    if (part?.type !== "change") return [];
    const additionStart = sourceHunk.additionStart + (part.additionLineIndex - sourceHunk.additionLineIndex);
    const deletionStart = sourceHunk.deletionStart + (part.deletionLineIndex - sourceHunk.deletionLineIndex);
    return [{
      ...sourceHunk,
      additionStart,
      additionCount: part.additions,
      additionLines: part.additions,
      additionLineIndex: part.additionLineIndex,
      deletionStart,
      deletionCount: part.deletions,
      deletionLines: part.deletions,
      deletionLineIndex: part.deletionLineIndex,
      hunkContent: [{ ...part }],
      hunkSpecs: undefined,
      noEOFCRAdditions: part === finalContent ? sourceHunk.noEOFCRAdditions : false,
      noEOFCRDeletions: part === finalContent ? sourceHunk.noEOFCRDeletions : false,
    }];
  });
}

function layoutCompactHunks(fileDiff: any, hunks: any[]): any {
  let additionEnd = 0;
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  for (const hunk of hunks) {
    const collapsedBefore = Math.max(hunk.additionStart - 1 - additionEnd, 0);
    const hunkSplitLineCount = hunk.hunkContent.reduce((count: number, part: any) => (
      count + (part.type === "context" ? part.lines : Math.max(part.additions, part.deletions))
    ), 0);
    const hunkUnifiedLineCount = hunk.hunkContent.reduce((count: number, part: any) => (
      count + (part.type === "context" ? part.lines : part.additions + part.deletions)
    ), 0);
    hunk.collapsedBefore = collapsedBefore;
    hunk.splitLineStart = splitLineCount + collapsedBefore;
    hunk.unifiedLineStart = unifiedLineCount + collapsedBefore;
    hunk.splitLineCount = hunkSplitLineCount;
    hunk.unifiedLineCount = hunkUnifiedLineCount;
    splitLineCount += collapsedBefore + hunkSplitLineCount;
    unifiedLineCount += collapsedBefore + hunkUnifiedLineCount;
    additionEnd = hunk.additionStart + hunk.additionCount - 1;
  }
  const trailingContext = Math.max((fileDiff.additionLines?.length ?? 0) - additionEnd, 0);
  return {
    ...fileDiff,
    // The sidecar's unlimited-context patch contains both complete file
    // versions even though Pierre's patch parser conservatively marks it
    // partial. Expansion requires this truthful derived value.
    isPartial: false,
    cacheKey: fileDiff.cacheKey == null
      ? undefined
      : `${fileDiff.cacheKey}:cmux-full-file:${hunks.map((hunk) => hunk.cmuxHunkId).join(",")}`,
    hunks,
    splitLineCount: splitLineCount + trailingContext,
    unifiedLineCount: unifiedLineCount + trailingContext,
  };
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
