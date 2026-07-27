export type DiffCommentSide = "additions" | "deletions";

export type DiffCommentRecord = {
  id: string;
  filePath: string;          // exactly fileName(item.fileDiff) for the item it belongs to
  side: DiffCommentSide;
  startLine: number;
  endLine: number;           // anchor line; annotation renders under endLine on `side`
  endSide?: DiffCommentSide;
  lineText: string;          // content of endLine at save time (anchor text, exact)
  message: string;
  submissionText?: string;   // precomputed text block consumed by the native pending pool
  consumedAt?: string;
  createdAt: string;         // ISO8601
  updatedAt: string;
  /** A native /ask result is displayed below its originating review comment. */
  parentId?: string;
  /** Answer records are presentation-only and cannot be edited or submitted. */
  readOnly?: boolean;
  /** Optional provider label, for example "GitHub Copilot". */
  author?: string;
  /** Aggregate review manifests may preserve the source repository label. */
  repositoryLabel?: string;
  /** Runtime-only owner of aggregate review feedback; not persisted in the comment payload. */
  repositoryRoot?: string;
  /** Lifecycle state for a native one-turn Copilot answer. */
  requestStatus?: "running" | "completed" | "failed";
  /** Persisted native sidecar identity; only native code uses these to resume work. */
  sidecarRequestId?: string;
  sidecarSessionId?: string;
};

export type DiffCommentSaveInput = Omit<DiffCommentRecord, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export type AnchorResult =
  | { state: "anchored"; line: number }
  | { state: "moved"; line: number; delta: number }
  | { state: "outdated" };

export type CommentDraft = {
  itemId: string;
  side: DiffCommentSide;
  startLine: number;
  endLine: number;
};

export type CommentAnnotationMetadata =
  | { kind: "draft" }
  | { kind: "comment"; comment: DiffCommentRecord; anchor: AnchorResult };
