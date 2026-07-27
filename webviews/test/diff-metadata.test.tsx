import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { annotateDiffMetadata, annotateHunks, decorateRenderedHunkGutters, DiffHeaderMetadata, resolveDiffHeaderMetadata, toggleExpandedHunkID } from "../src/diff-metadata";
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
  const fileDiff = {
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
      expandedHunkIDs={new Set([(fileDiff.hunks[0] as any).cmuxHunkId])}
    />,
  );
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const controls = dom.window.document.querySelectorAll("[data-cmux-full-file-hunk]");
  expect(controls).toHaveLength(2);
  expect(controls[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(controls[1]?.getAttribute("aria-pressed")).toBe("false");
  expect(controls[0]?.getAttribute("title")).toBe("Collapse unchanged context");
  expect(controls[1]?.getAttribute("title")).toBe("Expand unchanged context");
  dom.window.close();
});

test("Full File hunk controls toggle a stable ID without changing other hunks", () => {
  const expanded = new Set(["semantic-hunk-a"]);
  const collapsed = toggleExpandedHunkID(expanded, "semantic-hunk-a");
  const reopened = toggleExpandedHunkID(collapsed, "semantic-hunk-a");

  expect(expanded).toEqual(new Set(["semantic-hunk-a"]));
  expect(collapsed).toEqual(new Set());
  expect(reopened).toEqual(new Set(["semantic-hunk-a"]));
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
