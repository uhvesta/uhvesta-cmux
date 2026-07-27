import type { DiffCommentRecord } from "./types";

/**
 * Returns the durable parent IDs that must be refreshed after a viewer reload.
 * Native persists `running` on both the question and its read-only answer, so
 * an answer-only snapshot must still resume the parent request's poll.
 */
export function runningAskCommentIDs(comments: readonly DiffCommentRecord[]): string[] {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (comment.requestStatus !== "running") continue;
    ids.add(comment.parentId ?? comment.id);
  }
  return [...ids];
}

/** Poll until native SQLite no longer reports any running record for this ask. */
export function shouldContinueAskCommentPoll(
  comments: readonly DiffCommentRecord[],
  questionID: string,
): boolean {
  return comments.some((comment) =>
    (comment.id === questionID || comment.parentId === questionID) && comment.requestStatus === "running",
  );
}
