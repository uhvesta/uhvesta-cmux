import type { DiffCommentRecord } from "./comments/types";

/** Returns whether a persisted review comment is a one-shot Copilot question. */
export function isAskComment(comment: Pick<DiffCommentRecord, "message">): boolean {
  return /^\/ask(?:\s|$)/i.test(comment.message.trim());
}

/** SSH review sources have no local checkout for the one-turn Copilot sidecar. */
export function isRemoteReviewRoot(repoRoot: string | null | undefined): boolean {
  return typeof repoRoot === "string" && /^ssh:\/\//i.test(repoRoot.trim());
}

/**
 * Builds the review-level Markdown document used by Copy and the optional
 * native Send hook. Answer children are deliberately excluded: they are
 * read-only results, never feedback for the agent to apply.
 */
export function reviewPrompt(comments: readonly DiffCommentRecord[]): string {
  const feedback = comments
    .filter((comment) => comment.parentId == null && !comment.readOnly && !comment.consumedAt && !isAskComment(comment))
    .slice()
    .sort((left, right) => {
      const path = left.filePath.localeCompare(right.filePath);
      return path !== 0 ? path : left.startLine - right.startLine;
    });
  const sections = [
    "# Review feedback",
    "",
    "Apply only the requested changes below. Report ambiguous feedback instead of guessing.",
  ];
  if (feedback.length === 0) {
    return `${sections.join("\n")}\n\n_No open review feedback._\n`;
  }
  let activeRepository: string | null = null;
  for (const [index, comment] of feedback.entries()) {
    const repository = repositoryLabel(comment);
    if (repository !== activeRepository) {
      activeRepository = repository;
      sections.push("", `## Repository: ${inlineCode(repository)}`);
    }
    sections.push(
      "",
      `### Feedback ${index + 1}`,
      "",
      comment.submissionText?.trim() || fallbackFeedback(comment),
    );
  }
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

function repositoryLabel(comment: DiffCommentRecord): string {
  if (typeof comment.repositoryLabel === "string" && comment.repositoryLabel.trim() !== "") {
    return comment.repositoryLabel;
  }
  const firstPathSegment = comment.filePath.split("/")[0];
  return firstPathSegment && firstPathSegment !== comment.filePath ? firstPathSegment : "Current repository";
}

function fallbackFeedback(comment: DiffCommentRecord): string {
  const location = comment.startLine === comment.endLine
    ? `line ${comment.startLine}`
    : `lines ${comment.startLine}-${comment.endLine}`;
  return [
    `**File:** ${inlineCode(comment.filePath)}`,
    `**Location:** ${comment.side === "deletions" ? "old" : "new"} ${location}`,
    "",
    "**Review comment**",
    "",
    quote(comment.message),
  ].join("\n");
}
