import type { DiffViewerLabelKey, DiffViewerLabelResolver } from "../labels";

const DIFF_COMMENT_LABEL_KEYS = [
  "comments",
  "addComment",
  "commentPlaceholder",
  "saveComment",
  "cancelComment",
  "deleteComment",
  "editComment",
  "outdatedComment",
  "noComments",
  "answerFrom",
  "askComment",
  "askImmutable",
  "askUnavailableRemote",
] as const satisfies readonly DiffViewerLabelKey[];

export type DiffCommentLabelKey = typeof DIFF_COMMENT_LABEL_KEYS[number];
export type DiffCommentLabels = Record<DiffCommentLabelKey, string>;

/** Uses the required native diff-viewer label payload for every comment UI label. */
export function resolveCommentLabels(label: DiffViewerLabelResolver): DiffCommentLabels {
  const labels = {} as DiffCommentLabels;
  for (const key of DIFF_COMMENT_LABEL_KEYS) {
    labels[key] = label(key);
  }
  return labels;
}
