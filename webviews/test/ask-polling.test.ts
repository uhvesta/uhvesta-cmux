import { expect, test } from "bun:test";
import { runningAskCommentIDs, shouldContinueAskCommentPoll } from "../src/comments/ask-polling";
import type { DiffCommentRecord } from "../src/comments/types";

function comment(overrides: Partial<DiffCommentRecord> = {}): DiffCommentRecord {
  return {
    id: "question-1",
    filePath: "src/example.ts",
    side: "additions",
    startLine: 10,
    endLine: 10,
    lineText: "const value = 1;",
    message: "/ask Why is this needed?",
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:00:00Z",
    ...overrides,
  };
}

test("restored running /ask comments resume their durable parent poll", () => {
  const restored = [
    comment({ requestStatus: "running", repositoryRoot: "/repo" }),
    comment({
      id: "answer-1",
      parentId: "question-1",
      readOnly: true,
      message: "Copilot is preparing an answer…",
      requestStatus: "running",
      repositoryRoot: "/repo",
    }),
  ];

  expect(runningAskCommentIDs(restored)).toEqual(["question-1"]);
  expect(shouldContinueAskCommentPoll(restored, "question-1")).toBe(true);
});

test("restored /ask polling stops once the native SQLite snapshot is terminal", () => {
  const completed = [
    comment({ requestStatus: "completed" }),
    comment({
      id: "answer-1",
      parentId: "question-1",
      readOnly: true,
      message: "Because it protects the transaction.",
      requestStatus: "completed",
    }),
  ];

  expect(runningAskCommentIDs(completed)).toEqual([]);
  expect(shouldContinueAskCommentPoll(completed, "question-1")).toBe(false);
});

test("an answer-only restored snapshot still resumes its parent poll", () => {
  const restoredAnswer = comment({
    id: "answer-1",
    parentId: "question-1",
    readOnly: true,
    requestStatus: "running",
  });

  expect(runningAskCommentIDs([restoredAnswer])).toEqual(["question-1"]);
});
