const DEFAULT_DIFF_VIEWER_LABELS = {
  additions: "Additions",
  addComment: "Add comment",
  answerFrom: "Answer from {author}",
  askComment: "Ask Copilot",
  askImmutable: "Review questions cannot be edited. Delete the question and ask again.",
  askUnavailableRemote: "Copilot questions are unavailable for SSH review. Regular comments and review prompts still work.",
  bars: "Bars",
  binaryFile: "Binary file",
  branchBase: "Branch base",
  branchPickerCurrent: "current",
  branchPickerBasePrefix: "Base:",
  branchPickerComparing: "Comparing {head} against {base}",
  branchPickerFilterPlaceholder: "Filter branches",
  branchPickerGenerateFailed: "Could not generate the diff. Choose a branch to retry.",
  branchPickerGenerating: "Generating diff against {ref}...",
  branchPickerGroupBranches: "Branches",
  branchPickerGroupRecent: "Recent",
  branchPickerGroupRemotes: "Remotes",
  branchPickerGroupSuggested: "Suggested",
  branchPickerGroupWorktrees: "Worktrees",
  branchPickerLoadFailed: "Could not load branches.",
  branchPickerMore: "{count} more, type to filter",
  branchPickerLoading: "Loading branches...",
  branchPickerNoMatches: "No matching branches",
  branchPickerOpen: "Change diff base",
  branchPickerUseRaw: 'Use "{ref}" (raw)',
  changedFiles: "Changed files",
  classic: "Classic",
  collapseAllDiffs: "Collapse all diffs",
  collapseUnchangedContext: "Collapse unchanged context",
  cancelComment: "Cancel",
  commentPlaceholder: "Leave a comment",
  comments: "Comments",
  commit: "Commit",
  copyFailedReviewPrompt: "Could not copy review prompt.",
  copyFailedGitApplyCommand: "Could not copy git apply command.",
  copiedGitApplyCommand: "Copied git apply command",
  copiedReviewPrompt: "Copied review prompt",
  copyReviewPrompt: "Copy review prompt",
  deleteComment: "Delete",
  copyGitApplyCommand: "Copy git apply command",
  deletions: "Deletions",
  diffStats: "Diff stats",
  diffTarget: "Diff target",
  diffViewer: "Diff viewer",
  editComment: "Edit",
  disableWordDiffs: "Disable word diffs",
  disableWordWrap: "Disable word wrap",
  enableWordDiffs: "Enable word diffs",
  enableWordWrap: "Enable word wrap",
  expandAllDiffs: "Expand all diffs",
  expandUnchangedContext: "Expand unchanged context",
  fullFile: "Full File",
  files: "Files",
  hideBackgrounds: "Hide backgrounds",
  hideFiles: "Hide files",
  hideFileSearch: "Hide file search",
  hideLineNumbers: "Hide line numbers",
  indicatorStyle: "Indicator style",
  jumpToFile: "Jump to file",
  loadingDiff: "Loading diff...",
  loadingRenderer: "Loading renderer...",
  modeChange: "Mode {old} → {new}",
  noComments: "No comments yet",
  noFileDiffs: "No file diffs found in patch input.",
  none: "None",
  openSourceURL: "Open source URL",
  options: "Options",
  parsingDiff: "Parsing diff...",
  refresh: "Refresh",
  repository: "Repository",
  renderFailed: "Could not render this diff. Check the patch input and try again.",
  renderingDiff: "Rendering diff...",
  repoPath: "Repository path",
  showBackgrounds: "Show backgrounds",
  showFiles: "Show files",
  showFileSearch: "Show file search",
  showLineNumbers: "Show line numbers",
  saveComment: "Comment",
  switchToSplitDiff: "Switch to split diff",
  switchToFullFile: "Switch to Full File",
  switchToUnifiedDiff: "Switch to unified diff",
  queuedReviewPrompt: "Review prompt queued for the next terminal submission",
  sendReviewPrompt: "Send review prompt to terminal",
  sendReviewPromptFailed: "Could not queue review prompt",
  untitled: "Untitled",
  outdatedComment: "Outdated",
} as const;

const JAPANESE_LOCAL_FALLBACKS: Partial<Record<keyof typeof DEFAULT_DIFF_VIEWER_LABELS, string>> = {
  copyFailedReviewPrompt: "レビュー用プロンプトをコピーできませんでした。",
  copiedReviewPrompt: "レビュー用プロンプトをコピーしました",
  copyReviewPrompt: "レビュー用プロンプトをコピー",
  answerFrom: "{author} からの回答",
  askComment: "Copilot に質問",
  askImmutable: "レビューの質問は編集できません。削除してからもう一度質問してください。",
  askUnavailableRemote: "SSH レビューでは Copilot への質問は利用できません。通常のコメントとレビュープロンプトは引き続き利用できます。",
  fullFile: "ファイル全体",
  queuedReviewPrompt: "次のターミナル送信にレビュー用プロンプトを追加しました",
  sendReviewPrompt: "レビュー用プロンプトをターミナルへ送信",
  sendReviewPromptFailed: "レビュー用プロンプトを追加できませんでした",
  switchToFullFile: "ファイル全体表示に切り替え",
};

function localFallback(key: keyof typeof DEFAULT_DIFF_VIEWER_LABELS): string {
  const locale = typeof navigator !== "undefined" && typeof navigator.language === "string"
    ? navigator.language.toLowerCase()
    : "";
  if (locale.startsWith("ja")) return JAPANESE_LOCAL_FALLBACKS[key] ?? DEFAULT_DIFF_VIEWER_LABELS[key];
  return DEFAULT_DIFF_VIEWER_LABELS[key];
}

export type DiffViewerLabelKey = keyof typeof DEFAULT_DIFF_VIEWER_LABELS;
export type DiffViewerLabelResolver = (key: DiffViewerLabelKey) => string;

type LabelResolverOptions = {
  assertMissing?: boolean;
};

export function shouldAssertMissingLabels(): boolean {
  return Boolean(import.meta.env?.DEV);
}

export function createDiffViewerLabelResolver(
  labels: Record<string, string> | undefined,
  options: LabelResolverOptions = {}
): DiffViewerLabelResolver {
  const missingKeys = new Set<DiffViewerLabelKey>();
  return (key) => {
    const localizedValue = labels?.[key];
    if (typeof localizedValue === "string" && localizedValue.trim() !== "") {
      return localizedValue;
    }

    if (options.assertMissing && !missingKeys.has(key)) {
      missingKeys.add(key);
      throw new Error(`Missing cmux diff viewer label: ${key}`);
    }

    return localFallback(key);
  };
}
