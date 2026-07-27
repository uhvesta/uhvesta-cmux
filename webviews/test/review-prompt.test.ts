import { expect, test } from "bun:test";
import { isAskComment, isRemoteReviewRoot, reviewPrompt } from "../src/review-prompt";
import type { DiffCommentRecord } from "../src/comments/types";

function comment(overrides: Partial<DiffCommentRecord> = {}): DiffCommentRecord {
  return {
    id: "feedback-1",
    filePath: "repo-a/src/example.ts",
    side: "additions",
    startLine: 4,
    endLine: 4,
    lineText: "const answer = 42;",
    message: "Use a named constant.",
    submissionText: "## Review feedback\n\n**File:** `repo-a/src/example.ts`\n\n**Review comment**\n\n> Use a named constant.\n",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("aggregate review prompt groups feedback by repository and excludes answers and questions", () => {
  const prompt = reviewPrompt([
    comment({ id: "answer", parentId: "feedback-1", readOnly: true, message: "Because the value is shared." }),
    comment({ id: "question", filePath: "repo-b/src/question.ts", message: "/ask Is this safe?" }),
    comment({ id: "feedback-2", filePath: "repo-b/src/next.ts", repositoryLabel: "second repository" }),
    comment(),
  ]);

  expect(prompt).toContain("## Repository: `repo-a`");
  expect(prompt).toContain("## Repository: `second repository`");
  expect(prompt).toContain("### Feedback 1");
  expect(prompt).toContain("### Feedback 2");
  expect(prompt).not.toContain("Because the value is shared.");
  expect(prompt).not.toContain("Is this safe?");
  expect(isAskComment(comment({ message: " /ASK what changed?" }))).toBe(true);
});

test("review prompt excludes feedback that was already delivered", () => {
  const prompt = reviewPrompt([
    comment({ id: "consumed", consumedAt: "2026-01-02T00:00:00Z", message: "Already delivered" }),
    comment({ id: "pending", message: "Still pending", submissionText: undefined }),
  ]);

  expect(prompt).toContain("Still pending");
  expect(prompt).not.toContain("Already delivered");
});

test("SSH roots are identified before attempting a local Copilot sidecar", () => {
  expect(isRemoteReviewRoot("ssh://review-host/opt/src/repo")).toBe(true);
  expect(isRemoteReviewRoot("/Users/example/repo")).toBe(false);
});
