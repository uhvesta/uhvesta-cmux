import type { AgentEvent } from "./types";

const MAX_REVIEW_PROMPT_CHARS = 200_000;
const MAX_QUESTION_CHARS = 20_000;

export type ReviewQuestionKind = "question" | "review";

export interface ReviewQuestionRequest {
  repoRoot: string;
  reviewPrompt: string;
  question?: string;
  title?: string;
}

export interface NormalizedReviewQuestionRequest {
  repoRoot: string;
  reviewPrompt: string;
  question?: string;
  title: string;
  kind: ReviewQuestionKind;
}

export interface ReviewQuestionResult {
  id: string;
  sessionId: string;
  repoRoot: string;
  kind: ReviewQuestionKind;
  readOnly: true;
  status: "running" | "completed" | "failed";
  answer: string;
  error?: string;
}

/**
 * Constructs the isolated launch settings used only by a headless review
 * question. `repoRoot` must already be canonicalized with `realpath`: sandbox
 * subpath rules are literal, so `/tmp` and `/private/tmp` must not diverge.
 */
export function reviewOnlyCopilotLaunch(repoRoot: string): { sandboxProfile: string; args: string[] } {
  return {
    sandboxProfile: [
      "(version 1)",
      // Keep macOS's ordinary read, process, and networking allowances so
      // Copilot can start and authenticate, then make the entire child
      // process tree read-only. A subpath-only rule would still leave HOME,
      // temporary directories, and arbitrary absolute paths writable.
      "(allow default)",
      "(deny file-write*)",
    ].join("\n"),
    args: [
      "--excluded-tools=shell,write",
      "--deny-tool=shell",
      "--deny-tool=write",
      "--disable-builtin-mcps",
      "--disallow-temp-dir",
      "--no-ask-user",
      "--no-custom-instructions",
      "--no-remote",
      "--no-remote-export",
    ],
  };
}

/** Validates the deliberately small one-turn Copilot review API payload. */
export function normalizeReviewQuestionRequest(input: unknown): NormalizedReviewQuestionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("review question payload must be an object");
  }
  const raw = input as Record<string, unknown>;
  const repoRoot = stringValue(raw.repoRoot, "repoRoot");
  const reviewPrompt = stringValue(raw.reviewPrompt, "reviewPrompt");
  const question = optionalStringValue(raw.question, "question");
  const title = optionalStringValue(raw.title, "title");
  if (reviewPrompt.length > MAX_REVIEW_PROMPT_CHARS) {
    throw new Error(`reviewPrompt exceeds ${MAX_REVIEW_PROMPT_CHARS} characters`);
  }
  if (question && question.length > MAX_QUESTION_CHARS) {
    throw new Error(`question exceeds ${MAX_QUESTION_CHARS} characters`);
  }
  return {
    repoRoot,
    reviewPrompt,
    question,
    title: title ?? (question ? "Copilot review question" : "Copilot review"),
    kind: question ? "question" : "review",
  };
}

/**
 * Formats the only prompt a headless review session can send. The ACP session
 * also disables automatic permissions, so the agent receives review context
 * but cannot turn this route into a write-capable coding session.
 */
export function formatReadOnlyReviewPrompt(request: NormalizedReviewQuestionRequest): string {
  const lines = [
    "You are answering a code-review request in a read-only cmux review session.",
    "Do not modify files, run commands, invoke tools, or perform external side effects.",
    "Use only the review context below. Return a concise Markdown answer.",
    "",
    `Repository root: ${request.repoRoot}`,
  ];
  if (request.question) lines.push("", "Question:", request.question);
  lines.push("", "Review context:", request.reviewPrompt);
  return lines.join("\n");
}

/** Builds the initial state returned by the asynchronous review API. */
export function createReviewQuestionResult(
  id: string,
  request: NormalizedReviewQuestionRequest,
): ReviewQuestionResult {
  return {
    id,
    sessionId: id,
    repoRoot: request.repoRoot,
    kind: request.kind,
    readOnly: true,
    status: "running",
    answer: "",
  };
}

/** Folds normalized ACP events into the one-shot review result. */
export function reduceReviewQuestionEvent(
  result: ReviewQuestionResult,
  event: AgentEvent,
): ReviewQuestionResult {
  if (result.status !== "running") return result;
  switch (event.kind) {
    case "delta":
    case "assistant":
      return { ...result, answer: result.answer + event.text };
    case "error":
      return { ...result, error: event.message };
    case "done":
      return {
        ...result,
        status: result.error ? "failed" : "completed",
      };
    default:
      return result;
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, name);
}
