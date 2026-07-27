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
      const repository = repositoryLabel(left).localeCompare(repositoryLabel(right));
      if (repository !== 0) return repository;
      const repositoryIdentity = repositoryKey(left).localeCompare(repositoryKey(right));
      if (repositoryIdentity !== 0) return repositoryIdentity;
      const path = left.filePath.localeCompare(right.filePath);
      return path !== 0 ? path : left.startLine - right.startLine;
    });
  const repositoryKeysByLabel = new Map<string, Set<string>>();
  for (const comment of feedback) {
    const label = repositoryLabel(comment);
    const keys = repositoryKeysByLabel.get(label) ?? new Set<string>();
    keys.add(repositoryKey(comment));
    repositoryKeysByLabel.set(label, keys);
  }
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
    const repository = repositoryKey(comment);
    if (repository !== activeRepository) {
      activeRepository = repository;
      const label = repositoryLabel(comment);
      const duplicateLabel = (repositoryKeysByLabel.get(label)?.size ?? 0) > 1;
      const root = comment.repositoryRoot?.trim();
      const display = duplicateLabel && root ? `${label} (${root})` : label;
      sections.push("", `## Repository: ${inlineCode(display)}`);
    }
    sections.push(
      "",
      `### Feedback ${index + 1}`,
      "",
      focusedSubmissionText(comment).trim(),
    );
  }
  return `${sections.join("\n")}\n`;
}

/** Context for a one-turn `/ask`: only the selected location/code, never sibling feedback. */
export function reviewQuestionContext(comment: DiffCommentRecord): string {
  const focused = focusedSubmissionText(comment);
  const reviewComment = focused.indexOf("\n**Review comment**");
  if (reviewComment >= 0) return `${focused.slice(0, reviewComment).trim()}\n`;
  return focused;
}

/** Mirrors the native SQLite consumed state immediately after explicit terminal delivery. */
export function commentsAfterReviewPromptSent(
  comments: readonly DiffCommentRecord[],
  sentIDs: readonly string[],
  consumedAt: string,
): DiffCommentRecord[] {
  const sent = new Set(sentIDs);
  return comments.map((comment) => sent.has(comment.id) ? { ...comment, consumedAt } : comment);
}

function focusedSubmissionText(comment: DiffCommentRecord): string {
  const submission = comment.submissionText?.trim();
  if (!submission || !submission.includes("## Review feedback") || !submission.includes("**Diff context**")) {
    return submission ? `${submission}\n` : `${fallbackFeedback(comment)}\n`;
  }
  const selectedCode = selectedCodeFromLegacyDiff(comment, submission);
  if (!selectedCode) return `${fallbackFeedback(comment)}\n`;
  const location = comment.startLine === comment.endLine
    ? `line ${comment.startLine}`
    : `lines ${comment.startLine}-${comment.endLine}`;
  return [
    `**File:** ${inlineCode(comment.filePath)}`,
    `**Location:** ${comment.side === "deletions" ? "old" : "new"} ${location}`,
    "",
    "**Selected code**",
    "",
    `\`\`\`text\n${selectedCode}\n\`\`\``,
    "",
    "**Review comment**",
    "",
    quote(comment.message),
    "",
  ].join("\n");
}

function selectedCodeFromLegacyDiff(comment: DiffCommentRecord, submission: string): string | null {
  const fenced = /```diff\n([\s\S]*?)\n```/.exec(submission)?.[1];
  if (fenced == null) return null;
  let oldLine = 0;
  let newLine = 0;
  const selected: string[] = [];
  for (const line of fenced.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      const target = comment.side === "deletions" ? oldLine : newLine;
      if (target >= comment.startLine && target <= comment.endLine) selected.push(content);
      oldLine += 1;
      newLine += 1;
    } else if (prefix === "-") {
      if (comment.side === "deletions" && oldLine >= comment.startLine && oldLine <= comment.endLine) {
        selected.push(content);
      }
      oldLine += 1;
    } else if (prefix === "+") {
      if (comment.side !== "deletions" && newLine >= comment.startLine && newLine <= comment.endLine) {
        selected.push(content);
      }
      newLine += 1;
    }
  }
  return selected.length > 0 ? selected.join("\n") : null;
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
  return "Current repository";
}

function repositoryKey(comment: DiffCommentRecord): string {
  const root = comment.repositoryRoot?.trim();
  return root ? `root:${root}` : `label:${repositoryLabel(comment)}`;
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
