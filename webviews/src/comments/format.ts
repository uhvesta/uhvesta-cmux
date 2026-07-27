import { excerptFor, type CommentFileDiff } from "./anchor";
import type { DiffCommentRecord } from "./types";

export function commentBasename(filePath: string): string {
  const segments = filePath.split("/");
  const base = segments[segments.length - 1];
  return base != null && base !== "" ? base : filePath;
}

export function commentDisplayName(
  comment: Pick<DiffCommentRecord, "filePath" | "startLine" | "endLine">,
): string {
  const base = `${commentBasename(comment.filePath)}:${comment.startLine}`;
  return comment.endLine > comment.startLine ? `${base}-${comment.endLine}` : base;
}

/**
 * Builds the precomputed submission text stored with a saved comment. Native
 * code submits this block verbatim when the workspace pending pool is consumed.
 */
export function commentSubmissionText(
  comment: Pick<DiffCommentRecord, "filePath" | "side" | "startLine" | "endLine" | "message">,
  fileDiff: CommentFileDiff | null | undefined,
): string {
  const lineRef = comment.endLine > comment.startLine
    ? `lines ${comment.startLine}-${comment.endLine}`
    : `line ${comment.startLine}`;
  const version = comment.side === "deletions" ? "old" : "new";
  const sections = [
    `**File:** ${inlineCode(comment.filePath)}`,
    `**Location:** ${version} ${lineRef}`,
  ];
  const excerpt = excerptFor(fileDiff, comment.side, comment.startLine, comment.endLine);
  if (excerpt !== "") {
    sections.push("", "**Selected code**", "", `\`\`\`text\n${excerpt}\n\`\`\``);
  }
  sections.push("", "**Review comment**", "", quote(comment.message));
  return `${sections.join("\n")}\n`;
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  return `${fence}${value}${fence}`;
}

function quote(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    .map((line) => line === "" ? ">" : `> ${line}`)
    .join("\n");
}
