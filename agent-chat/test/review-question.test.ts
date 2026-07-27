import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReviewQuestionResult,
  formatReadOnlyReviewPrompt,
  normalizeReviewQuestionRequest,
  reduceReviewQuestionEvent,
  reviewOnlyCopilotLaunch,
} from "../review-question";

test("review question contract preserves review context and only completes one read-only turn", () => {
  const request = normalizeReviewQuestionRequest({
    requestId: "question-1",
    repoRoot: "/repo/cmux",
    question: "Why was this branch added?",
    reviewPrompt: "## Sources/Foo.swift\n\n> + let branch = true",
  });
  expect(request.kind).toBe("question");
  const prompt = formatReadOnlyReviewPrompt(request);
  expect(prompt).toContain("Do not modify files, run commands, invoke tools");
  expect(prompt).toContain("Repository root: /repo/cmux");
  expect(prompt).toContain("Why was this branch added?");
  expect(prompt).toContain("> + let branch = true");

  let result = createReviewQuestionResult("question-1", request);
  result = reduceReviewQuestionEvent(result, { kind: "delta", text: "It " });
  result = reduceReviewQuestionEvent(result, { kind: "delta", text: "guards a fallback." });
  result = reduceReviewQuestionEvent(result, { kind: "done" });
  expect(result).toMatchObject({
    id: "question-1",
    sessionId: "question-1",
    readOnly: true,
    status: "completed",
    answer: "It guards a fallback.",
  });
});

test("review-only Copilot launch globally denies writes and shell tools", async () => {
  const launch = reviewOnlyCopilotLaunch("/private/tmp/cmux-review-root");
  expect(launch.sandboxProfile).toContain("(deny file-write*)");
  expect(launch.sandboxProfile).not.toContain("subpath");
  expect(launch.args).toEqual(expect.arrayContaining([
    "--excluded-tools=shell,write",
    "--deny-tool=shell",
    "--deny-tool=write",
    "--disable-builtin-mcps",
  ]));

  if (process.platform !== "darwin") return;
  const sandboxRoot = await mkdtemp(join(tmpdir(), "cmux-review-sandbox-"));
  const deniedPath = join(sandboxRoot, "must-not-exist");
  try {
    const proc = Bun.spawn([
      "/usr/bin/sandbox-exec", "-p", launch.sandboxProfile,
      "/bin/sh", "-c", `printf blocked > ${JSON.stringify(deniedPath)}`,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).not.toBe(0);
    expect(await Bun.file(deniedPath).exists()).toBe(false);
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

test("review-only handoff completes as failed when ACP reports an error", () => {
  const request = normalizeReviewQuestionRequest({
    requestId: "review-1",
    repoRoot: "/repo/cmux",
    reviewPrompt: "# Review prompt\nPlease summarize the changed hunk.",
  });
  let result = createReviewQuestionResult("review-1", request);
  result = reduceReviewQuestionEvent(result, { kind: "error", message: "Copilot is not authenticated" });
  result = reduceReviewQuestionEvent(result, { kind: "done" });
  expect(result.kind).toBe("review");
  expect(result.status).toBe("failed");
  expect(result.error).toBe("Copilot is not authenticated");
});

test("review question rejects an empty repository root or review context", () => {
  expect(() => normalizeReviewQuestionRequest({ requestId: "request-1", repoRoot: "", reviewPrompt: "context" })).toThrow("repoRoot");
  expect(() => normalizeReviewQuestionRequest({ requestId: "request-1", repoRoot: "/repo", reviewPrompt: "" })).toThrow("reviewPrompt");
  expect(() => normalizeReviewQuestionRequest({ repoRoot: "/repo", reviewPrompt: "context" })).toThrow("requestId");
});
