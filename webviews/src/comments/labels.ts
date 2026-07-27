const DIFF_COMMENT_LABEL_FALLBACKS = {
  comments: "Comments",
  addComment: "Add comment",
  commentPlaceholder: "Leave a comment",
  saveComment: "Comment",
  cancelComment: "Cancel",
  deleteComment: "Delete",
  editComment: "Edit",
  outdatedComment: "Outdated",
  noComments: "No comments yet",
  answerFrom: "Answer from {author}",
  askComment: "Ask Copilot",
  askUnavailableRemote: "Copilot questions are unavailable for SSH review. Regular comments and review prompts still work.",
} as const;

const JAPANESE_COMMENT_FALLBACKS: Partial<Record<keyof typeof DIFF_COMMENT_LABEL_FALLBACKS, string>> = {
  answerFrom: "{author} からの回答",
  askComment: "Copilot に質問",
  askUnavailableRemote: "SSH レビューでは Copilot への質問は利用できません。通常のコメントとレビュープロンプトは引き続き利用できます。",
};

export type DiffCommentLabelKey = keyof typeof DIFF_COMMENT_LABEL_FALLBACKS;
export type DiffCommentLabels = Record<DiffCommentLabelKey, string>;

type LabelsPayload = { labels?: Record<string, string> } | null | undefined;

/**
 * Resolves a comments label from the payload with an inline fallback. These
 * keys are newer than the base diff viewer labels, so older payloads may not
 * carry them; unlike the main resolver this never asserts on missing keys.
 */
export function commentLabel(payload: LabelsPayload, key: DiffCommentLabelKey, fallback: string): string {
  const localized = payload?.labels?.[key];
  if (typeof localized === "string" && localized.trim() !== "") return localized;
  const locale = typeof navigator !== "undefined" && typeof navigator.language === "string"
    ? navigator.language.toLowerCase()
    : "";
  if (locale.startsWith("ja")) return JAPANESE_COMMENT_FALLBACKS[key] ?? fallback;
  return fallback;
}

export function resolveCommentLabels(payload: LabelsPayload): DiffCommentLabels {
  const labels = {} as DiffCommentLabels;
  for (const key of Object.keys(DIFF_COMMENT_LABEL_FALLBACKS) as DiffCommentLabelKey[]) {
    labels[key] = commentLabel(payload, key, DIFF_COMMENT_LABEL_FALLBACKS[key]);
  }
  return labels;
}
