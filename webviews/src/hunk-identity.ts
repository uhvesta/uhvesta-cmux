/**
 * Stable, per-file hunk identities.
 *
 * A parsed patch's line numbers and line-array offsets are presentation
 * coordinates: both change when unrelated lines are inserted above a hunk.
 * Keep those coordinates out of the signature.  The coordinate values below
 * are used only to read Pierre's already-parsed hunk text.
 */

type HunkRecord = Record<string, unknown>;

export type HunkIdentityInput = {
  filePath: string;
  hunks: readonly unknown[];
  additionLines?: readonly unknown[];
  deletionLines?: readonly unknown[];
};

/**
 * Creates one deterministic ID per hunk. Duplicate semantic hunks receive a
 * one-based occurrence suffix within only that duplicate group, so inserting
 * an unrelated hunk before them cannot renumber their identities.
 */
export function hunkIdentityIDs(input: HunkIdentityInput): string[] {
  const signatures = input.hunks.map((hunk) => hunkSemanticSignature(input.filePath, hunk, input));
  const totals = new Map<string, number>();
  for (const signature of signatures) {
    totals.set(signature, (totals.get(signature) ?? 0) + 1);
  }

  const occurrences = new Map<string, number>();
  return signatures.map((signature) => {
    const baseID = `h${stableHash(signature)}`;
    if (totals.get(signature) === 1) return baseID;
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    return `${baseID}-${occurrence}`;
  });
}

/**
 * Returns the semantic representation used by {@link hunkIdentityIDs}. It is
 * exported for behavior tests and intentionally excludes absolute positions.
 */
export function hunkSemanticSignature(
  filePath: string,
  value: unknown,
  lines: Pick<HunkIdentityInput, "additionLines" | "deletionLines"> = {},
): string {
  const hunk = asRecord(value);
  const additionLines = stringLines(lines.additionLines);
  const deletionLines = stringLines(lines.deletionLines);
  const content = semanticContent(hunk, additionLines, deletionLines);
  return JSON.stringify({
    version: 1,
    filePath: normalizeText(filePath),
    header: hunkHeaderContext(hunk),
    content: content.length > 0 ? content : fallbackShape(hunk),
  });
}

function semanticContent(hunk: HunkRecord, additionLines: readonly string[], deletionLines: readonly string[]): unknown[] {
  const source = Array.isArray(hunk.hunkContent) ? hunk.hunkContent : [];
  const content: unknown[] = [];
  for (const value of source) {
    const segment = asRecord(value);
    if (segment.type === "context") {
      content.push(["context", readLines(additionLines, segment.additionLineIndex, segment.lines)]);
      continue;
    }
    if (segment.type === "change") {
      content.push([
        "change",
        readLines(deletionLines, segment.deletionLineIndex, segment.deletions),
        readLines(additionLines, segment.additionLineIndex, segment.additions),
      ]);
    }
  }
  return content;
}

function fallbackShape(hunk: HunkRecord): unknown[] {
  // Synthetic/partial hunk objects may omit text. Counts still distinguish
  // their shape without reintroducing line-number coordinates into the ID.
  return [[
    "shape",
    finiteCount(hunk.deletionCount),
    finiteCount(hunk.deletionLines),
    finiteCount(hunk.additionCount),
    finiteCount(hunk.additionLines),
  ]];
}

function hunkHeaderContext(hunk: HunkRecord): string {
  const explicit = stringValue(hunk.hunkContext);
  if (explicit != null) return normalizeText(explicit);
  for (const key of ["hunkHeader", "header", "hunkSpecs"]) {
    const value = stringValue(hunk[key]);
    if (value == null) continue;
    // Strip the unstable @@ -old,+new @@ coordinates if this is a raw header.
    const match = /^@@\s*-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@\s*(.*)$/s.exec(value);
    return normalizeText(match?.[1] ?? value);
  }
  return "";
}

function readLines(lines: readonly string[], start: unknown, count: unknown): string[] {
  const offset = finiteCount(start);
  const length = finiteCount(count);
  if (offset == null || length == null || length === 0) return [];
  return lines.slice(offset, offset + length).map(normalizeText);
}

function stringLines(value: unknown): string[] {
  return Array.isArray(value) ? value.map((line) => normalizeText(String(line))) : [];
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): HunkRecord {
  return value != null && typeof value === "object" ? value as HunkRecord : {};
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
