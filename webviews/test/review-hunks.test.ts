import { expect, test } from "bun:test";
import { annotateHunks } from "../src/diff-metadata";
import { adjacentReviewHunk, requestedReviewHunk, reviewHunks } from "../src/review-hunks";
import type { DiffItem } from "../src/diff-stream";

function item(id: string, starts: number[]): DiffItem {
  const fileDiff = {
    name: id,
    hunks: starts.map((additionStart, index) => ({
      additionStart,
      additionCount: 2,
      deletionStart: additionStart - 1,
      deletionCount: 2,
      additionLineIndex: index * 2,
      deletionLineIndex: index * 2,
    })),
  };
  annotateHunks(fileDiff);
  return { id, type: "diff", fileDiff, version: 0 } as DiffItem;
}

function semanticItem(id: string, hunks: Array<{ header: string; old: string; next: string }>, firstLine: number): DiffItem {
  const additionLines: string[] = [];
  const deletionLines: string[] = [];
  const fileDiff = {
    name: id,
    additionLines,
    deletionLines,
    hunks: hunks.map((change, index) => {
      const additionLineIndex = additionLines.length;
      const deletionLineIndex = deletionLines.length;
      additionLines.push(`${change.next}\n`);
      deletionLines.push(`${change.old}\n`);
      const line = firstLine + index * 11;
      return {
        additionStart: line,
        additionCount: 1,
        additionLineIndex,
        deletionStart: line - 1,
        deletionCount: 1,
        deletionLineIndex,
        hunkContext: change.header,
        hunkContent: [{ type: "change", additions: 1, additionLineIndex, deletions: 1, deletionLineIndex }],
      };
    }),
  };
  annotateHunks(fileDiff);
  return { id, type: "diff", fileDiff, version: 0 } as DiffItem;
}

test("review hunk identities survive a fresh parsed object and navigation stays ordered", () => {
  const first = item("src/first.ts", [10, 30]);
  const refreshed = item("src/first.ts", [10, 30]);
  const second = item("src/second.ts", [7]);
  const hunks = reviewHunks([first, second]);

  expect(hunks.slice(0, 2).map((hunk) => hunk.hunkId)).toEqual(reviewHunks([refreshed]).map((hunk) => hunk.hunkId));
  expect(hunks.map((hunk) => [hunk.itemId, hunk.lineNumber])).toEqual([
    ["src/first.ts", 10],
    ["src/first.ts", 30],
    ["src/second.ts", 7],
  ]);
  expect(adjacentReviewHunk(hunks, { itemId: first.id, lineNumber: 10, side: "additions" }, 1)).toMatchObject({ lineNumber: 30 });
  expect(adjacentReviewHunk(hunks, { itemId: first.id, lineNumber: 30, side: "additions" }, 1)).toMatchObject({ itemId: second.id, lineNumber: 7 });
  expect(adjacentReviewHunk(hunks, { itemId: second.id, lineNumber: 7, side: "additions" }, -1)).toMatchObject({ itemId: first.id, lineNumber: 30 });
  expect(requestedReviewHunk([first, second], 3)).toMatchObject({ itemId: second.id, lineNumber: 7 });
  expect(requestedReviewHunk([first], "not-a-hunk")).toBeNull();
});

test("review cursors retain semantic hunk identity after offsets shift and an earlier hunk appears", () => {
  const original = semanticItem("src/first.ts", [
    { header: "target", old: "old target", next: "new target" },
    { header: "keep", old: "old keep", next: "new keep" },
  ], 10);
  const refreshed = semanticItem("src/first.ts", [
    { header: "unrelated", old: "old unrelated", next: "new unrelated" },
    { header: "target", old: "old target", next: "new target" },
    { header: "keep", old: "old keep", next: "new keep" },
  ], 200);

  const originalHunks = reviewHunks([original]);
  const refreshedHunks = reviewHunks([refreshed]);
  expect(originalHunks.map((hunk) => hunk.hunkId)).toEqual([
    refreshedHunks[1]?.hunkId,
    refreshedHunks[2]?.hunkId,
  ]);
  expect(adjacentReviewHunk(refreshedHunks, { itemId: refreshed.id, lineNumber: 211, side: "additions" }, 1))
    .toMatchObject({ hunkId: refreshedHunks[2]?.hunkId });
});

test("direct hunk requests resolve within their repository and file instead of the flattened aggregate", () => {
  const repoA = item("repo-a/src/shared.ts", [10, 30]);
  repoA.commentFilePath = "src/shared.ts";
  repoA.commentRepoRoot = "/work/repo-a";
  const repoB = item("repo-b/src/shared.ts", [7, 18]);
  repoB.commentFilePath = "src/shared.ts";
  repoB.commentRepoRoot = "/work/repo-b";

  expect(requestedReviewHunk([repoA, repoB], {
    hunk: 2,
    file: "src/shared.ts",
    repoRoot: "/work/repo-b",
  })).toMatchObject({ itemId: repoB.id, lineNumber: 18, repositoryRoot: "/work/repo-b" });
});
