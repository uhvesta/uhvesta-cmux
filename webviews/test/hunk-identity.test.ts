import { expect, test } from "bun:test";
import { hunkIdentityIDs, hunkSemanticSignature } from "../src/hunk-identity";

test("hunk semantic signatures exclude absolute patch coordinates", () => {
  const before = hunk({ additionStart: 12, deletionStart: 11, additionLineIndex: 0, deletionLineIndex: 0 });
  const shifted = hunk({
    additionStart: 412,
    deletionStart: 411,
    additionLineIndex: 9,
    deletionLineIndex: 9,
    hunkContent: [{ type: "change", additions: 1, additionLineIndex: 9, deletions: 1, deletionLineIndex: 9 }],
  });
  const lines = { additionLines: ["new value\n"], deletionLines: ["old value\n"] };
  const shiftedLines = {
    additionLines: [...Array.from({ length: 9 }, () => "unrelated\n"), "new value\n"],
    deletionLines: [...Array.from({ length: 9 }, () => "unrelated\n"), "old value\n"],
  };

  expect(hunkSemanticSignature("src/example.ts", before, lines))
    .toBe(hunkSemanticSignature("src/example.ts", shifted, shiftedLines));
});

test("identical semantic hunks are unique and unrelated insertion preserves their occurrence IDs", () => {
  const duplicateA = hunk({ additionStart: 10, deletionStart: 9, additionLineIndex: 0, deletionLineIndex: 0 });
  const duplicateB = hunk({ additionStart: 30, deletionStart: 29, additionLineIndex: 1, deletionLineIndex: 1 });
  const unrelated = hunk({
    additionStart: 1,
    deletionStart: 1,
    additionLineIndex: 2,
    deletionLineIndex: 2,
    hunkContext: "other",
    hunkContent: [{ type: "change", additions: 1, additionLineIndex: 2, deletions: 1, deletionLineIndex: 2 }],
  });
  const lines = {
    additionLines: ["new value\n", "new value\n", "new other\n"],
    deletionLines: ["old value\n", "old value\n", "old other\n"],
  };

  const original = hunkIdentityIDs({ filePath: "src/example.ts", hunks: [duplicateA, duplicateB], ...lines });
  const refreshed = hunkIdentityIDs({ filePath: "src/example.ts", hunks: [unrelated, duplicateA, duplicateB], ...lines });

  expect(new Set(original).size).toBe(2);
  expect(original).toEqual(refreshed.slice(1));
});

function hunk(overrides: Record<string, unknown>) {
  return {
    additionCount: 1,
    deletionCount: 1,
    hunkContext: "target",
    hunkContent: [{ type: "change", additions: 1, additionLineIndex: 0, deletions: 1, deletionLineIndex: 0 }],
    ...overrides,
  };
}
