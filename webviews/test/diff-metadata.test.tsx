import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { annotateDiffMetadata, annotateHunks, decorateRenderedHunkGutters, DiffHeaderMetadata, fullFileDiffWithCollapsedHunks, fullFileHunkIsExpanded, resolveDiffHeaderMetadata, scopedHunkID, toggleExpandedHunkID } from "../src/diff-metadata";
import { createDiffViewerLabelResolver } from "../src/labels";

test("binary and mode-only diffs render explicit localized header metadata", () => {
  const binary = {
    type: "change",
    hunks: [],
    prevObjectId: "1111111",
    newObjectId: "2222222",
    mode: "100644",
  };
  const mode = {
    type: "change",
    hunks: [],
    prevMode: "100644",
    mode: "100755",
  };
  annotateDiffMetadata(binary, "GIT binary patch\n");
  annotateDiffMetadata(mode);
  const label = createDiffViewerLabelResolver({
    binaryFile: "Localized binary",
    modeChange: "Permissions {old} to {new}",
  });
  expect(resolveDiffHeaderMetadata(binary, label)).toBe("Localized binary");
  expect(resolveDiffHeaderMetadata(mode, label)).toBe("Permissions 100644 to 100755");

  const html = renderToStaticMarkup(
    <>
      <DiffHeaderMetadata fileDiff={binary} label={label} />
      <DiffHeaderMetadata fileDiff={mode} label={label} />
    </>,
  );
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const container = dom.window.document.getElementById("root")!;
  expect(container.querySelector('[data-cmux-diff-metadata="binary"]')?.textContent).toBe("Localized binary");
  expect(container.querySelector('[data-cmux-diff-metadata="mode"]')?.textContent).toBe("Permissions 100644 to 100755");
  dom.window.close();
});

test("stable hunk numbers are attached to Pierre's rendered gutter", () => {
  const fileDiff: any = {
    name: "src/example.ts",
    hunks: [
      { additionStart: 10, additionCount: 2, deletionStart: 9, deletionCount: 2 },
      { additionStart: 42, additionCount: 1, deletionStart: 41, deletionCount: 1 },
    ],
  };
  annotateHunks(fileDiff);
  const dom = new JSDOM("<div id='root'><div id='host'></div></div>");
  const host = dom.window.document.getElementById("host")!;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<div data-column-number='10'></div><div data-column-number='42'></div>";

  decorateRenderedHunkGutters(dom.window.document.getElementById("root")!, fileDiff);

  expect(shadow.querySelector('[data-cmux-hunk-badge="1"]')?.textContent).toBe("1");
  expect(shadow.querySelector('[data-cmux-hunk-badge="2"]')?.textContent).toBe("2");
  expect(fileDiff.hunks.map((hunk: any) => hunk.cmuxHunkId)).toHaveLength(2);
  dom.window.close();
});

test("Full File exposes stable per-hunk expansion controls", () => {
  const fileDiff = {
    name: "src/example.ts",
    hunks: [{ additionStart: 10, deletionStart: 9 }, { additionStart: 30, deletionStart: 29 }],
  };
  annotateHunks(fileDiff);
  const label = createDiffViewerLabelResolver({ expandUnchangedContext: "Expand unchanged context" });
  const html = renderToStaticMarkup(
    <DiffHeaderMetadata
      fileDiff={fileDiff}
      label={label}
      fullFile
      hunkScope="repo:src/example.ts"
      collapsedHunkIDs={new Set([
        scopedHunkID("repo:src/example.ts", (fileDiff.hunks[0] as any).cmuxHunkId),
      ])}
    />,
  );
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const controls = dom.window.document.querySelectorAll("[data-cmux-full-file-hunk]");
  expect(controls).toHaveLength(2);
  expect(controls[0]?.getAttribute("aria-pressed")).toBe("false");
  expect(controls[1]?.getAttribute("aria-pressed")).toBe("true");
  expect(controls[0]?.getAttribute("title")).toBe("Expand unchanged context");
  expect(controls[1]?.getAttribute("title")).toBe("Collapse unchanged context");
  dom.window.close();
});

test("Full File expands every hunk by default", () => {
  expect(fullFileHunkIsExpanded(new Set(), "repo:src/example.ts", "semantic-hunk-a")).toBe(true);
  expect(fullFileHunkIsExpanded(
    new Set([scopedHunkID("repo:src/example.ts", "semantic-hunk-a")]),
    "repo:src/example.ts",
    "semantic-hunk-a",
  )).toBe(false);
});

test("Full File hunk controls toggle a stable ID without changing other hunks", () => {
  const expanded = new Set(["semantic-hunk-a"]);
  const collapsed = toggleExpandedHunkID(expanded, "semantic-hunk-a");
  const reopened = toggleExpandedHunkID(collapsed, "semantic-hunk-a");

  expect(expanded).toEqual(new Set(["semantic-hunk-a"]));
  expect(collapsed).toEqual(new Set());
  expect(reopened).toEqual(new Set(["semantic-hunk-a"]));
});

test("Full File hunk state is scoped to its aggregate repository item", () => {
  expect(scopedHunkID("repo-a:src/example.ts", "semantic-hunk-a"))
    .not.toBe(scopedHunkID("repo-b:src/example.ts", "semantic-hunk-a"));
});

test("collapsing a Full File hunk gives Pierre real collapsed context while preserving its semantic identity", () => {
  const fileDiff: any = {
    name: "src/example.ts",
    // Git patches remain marked partial even when the sidecar requested
    // effectively unlimited context and therefore supplied the full file.
    isPartial: true,
    additionLines: Array.from({ length: 40 }, (_, index) => `new ${index + 1}\n`),
    deletionLines: Array.from({ length: 40 }, (_, index) => `old ${index + 1}\n`),
    hunks: [{
      additionStart: 1,
      additionCount: 40,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 40,
      deletionLineIndex: 0,
      hunkContent: [
        { type: "context", lines: 9, additionLineIndex: 0, deletionLineIndex: 0 },
        { type: "change", additions: 1, deletions: 1, additionLineIndex: 9, deletionLineIndex: 9 },
        { type: "context", lines: 19, additionLineIndex: 10, deletionLineIndex: 10 },
        { type: "change", additions: 1, deletions: 1, additionLineIndex: 29, deletionLineIndex: 29 },
        { type: "context", lines: 10, additionLineIndex: 30, deletionLineIndex: 30 },
      ],
      splitLineStart: 0,
      splitLineCount: 40,
      unifiedLineStart: 0,
      unifiedLineCount: 42,
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    }],
  };
  annotateHunks(fileDiff);

  const hunkId = fileDiff.hunks[0]!.cmuxHunkId;
  const collapsed = fullFileDiffWithCollapsedHunks(fileDiff, "repo:src/example.ts", new Set([
    scopedHunkID("repo:src/example.ts", hunkId),
  ]));

  expect(collapsed).not.toBe(fileDiff);
  expect(collapsed.isPartial).toBe(false);
  expect(collapsed.hunks).toHaveLength(2);
  expect(collapsed.hunks.map((hunk: any) => hunk.cmuxHunkId)).toEqual([hunkId, hunkId]);
  expect(collapsed.hunks.every((hunk: any) => hunk.hunkContent.every((part: any) => part.type === "change"))).toBe(true);
  expect(collapsed.hunks[0].collapsedBefore).toBe(9);
  expect(collapsed.hunks[1].collapsedBefore).toBe(19);
  expect(fileDiff.hunks[0]!.hunkContent.some((part: any) => part.type === "context")).toBe(true);
});

test("hunk identities survive shifted patch coordinates and an earlier unrelated hunk", () => {
  const original = semanticFileDiff([
    { header: "function target()", old: ["before target"], next: ["after target"] },
    { header: "function keep()", old: ["before keep"], next: ["after keep"] },
  ], 10);
  const refreshed = semanticFileDiff([
    { header: "function unrelated()", old: ["before unrelated"], next: ["after unrelated"] },
    { header: "function target()", old: ["before target"], next: ["after target"] },
    { header: "function keep()", old: ["before keep"], next: ["after keep"] },
  ], 200);

  annotateHunks(original);
  annotateHunks(refreshed);

  expect(original.hunks.map((hunk: any) => hunk.cmuxHunkId)).toEqual([
    (refreshed.hunks[1] as any).cmuxHunkId,
    (refreshed.hunks[2] as any).cmuxHunkId,
  ]);
  expect(original.hunks.map((hunk: any) => hunk.cmuxHunkNumber)).toEqual([1, 2]);
  expect(refreshed.hunks.map((hunk: any) => hunk.cmuxHunkNumber)).toEqual([1, 2, 3]);
});

function semanticFileDiff(
  changes: Array<{ header: string; old: string[]; next: string[] }>,
  firstLine: number,
) {
  const additionLines: string[] = [];
  const deletionLines: string[] = [];
  return {
    name: "src/example.ts",
    additionLines,
    deletionLines,
    hunks: changes.map((change, index) => {
      const additionLineIndex = additionLines.length;
      const deletionLineIndex = deletionLines.length;
      additionLines.push(...change.next.map((line) => `${line}\n`));
      deletionLines.push(...change.old.map((line) => `${line}\n`));
      const line = firstLine + index * 20;
      return {
        additionStart: line,
        additionCount: change.next.length,
        additionLineIndex,
        deletionStart: line - 1,
        deletionCount: change.old.length,
        deletionLineIndex,
        hunkContext: change.header,
        hunkContent: [{
          type: "change",
          additions: change.next.length,
          additionLineIndex,
          deletions: change.old.length,
          deletionLineIndex,
        }],
      };
    }),
  };
}
