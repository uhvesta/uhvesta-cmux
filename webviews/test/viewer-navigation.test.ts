import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import "../../Resources/markdown-viewer/viewer-navigation.js";

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
});

test("viewer navigation shares smooth Vim and Emacs motions", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'></div></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  Object.defineProperties(viewer, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2_400 },
  });
  const calls: Array<["to", ScrollToOptions]> = [];
  viewer.scrollTo = ((options: ScrollToOptions) => { calls.push(["to", options]); }) as typeof viewer.scrollTo;

  const dispose = CmuxViewerNavigation.install({
    target: dom.window.document,
    getScroller: () => viewer,
    shortcuts: {
      diffViewerScrollDown: shortcut("j"),
      diffViewerScrollUp: shortcut("k"),
      diffViewerScrollHalfPageDown: shortcut("d", { control: true }),
      diffViewerScrollHalfPageUp: shortcut("u", { control: true }),
      diffViewerScrollDownEmacs: shortcut("n", { control: true }),
      diffViewerScrollUpEmacs: shortcut("p", { control: true }),
      diffViewerScrollToBottom: shortcut("g", { shift: true }),
      diffViewerScrollToTop: chord("g", "g"),
    },
  });

  dispatchKey("j");
  viewer.scrollTop = 600;
  dom.window.document.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true }));
  dispatchKey("j");
  dispatchKey("d", { ctrlKey: true });
  dispatchKey("p", { ctrlKey: true });
  dispatchKey("G", { shiftKey: true });
  dispatchKey("g");
  dispatchKey("g");

  expect(calls).toEqual([
    ["to", { top: 72, behavior: "smooth" }],
    ["to", { top: 672, behavior: "smooth" }],
    ["to", { top: 972, behavior: "smooth" }],
    ["to", { top: 900, behavior: "smooth" }],
    ["to", { top: 1_800, behavior: "smooth" }],
    ["to", { top: 0, behavior: "smooth" }],
  ]);
  dispose();

  function dispatchKey(key: string, init: KeyboardEventInit = {}) {
    dom?.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key, ...init }));
  }
});

test("viewer navigation leaves editable controls and unbound shortcuts alone", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'></div><textarea id='editor'></textarea></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  let scrollCount = 0;
  viewer.scrollTo = () => { scrollCount += 1; };
  const dispose = CmuxViewerNavigation.install({
    target: dom.window.document,
    getScroller: () => viewer,
    shortcuts: {
      diffViewerScrollDown: shortcut("j"),
      diffViewerScrollHalfPageDown: { unbound: true },
    },
  });

  const editor = dom.window.document.getElementById("editor")!;
  editor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "j" }));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "d", ctrlKey: true }));

  expect(scrollCount).toBe(0);
  dispose();
});

test("direct viewer actions reset their smooth target after manual input", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'></div></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  Object.defineProperties(viewer, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2_400 },
  });
  const tops: number[] = [];
  viewer.scrollTo = ((options: ScrollToOptions) => { tops.push(Number(options.top)); }) as typeof viewer.scrollTo;
  const dispose = CmuxViewerNavigation.installManualInputReset({
    target: dom.window.document,
    getScroller: () => viewer,
  });

  CmuxViewerNavigation.performAction("diffViewerScrollDown", viewer);
  viewer.scrollTop = 600;
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "PageDown" }));
  CmuxViewerNavigation.performAction("diffViewerScrollDown", viewer);
  viewer.scrollTop = 900;
  dom.window.document.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true }));
  CmuxViewerNavigation.performAction("diffViewerScrollDown", viewer);

  expect(tops).toEqual([72, 672, 972]);
  dispose();
});

test("programmatic jumps can reset a pending smooth target", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'></div></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  Object.defineProperties(viewer, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2_400 },
  });
  const tops: number[] = [];
  viewer.scrollTo = ((options: ScrollToOptions) => { tops.push(Number(options.top)); }) as typeof viewer.scrollTo;

  CmuxViewerNavigation.performAction("diffViewerScrollDown", viewer);
  viewer.scrollTop = 1_000;
  CmuxViewerNavigation.resetSmoothTarget(viewer);
  CmuxViewerNavigation.performAction("diffViewerScrollDown", viewer);

  expect(tops).toEqual([72, 1_072]);
});

test("rendered-row navigation walks Pierre shadow rows without materializing offscreen lines", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'><div id='host'></div></div></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  const host = dom.window.document.getElementById("host") as HTMLElement;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = "<div data-line='10'></div><div data-line='11'></div><div data-line='12'></div>";
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-line]"));
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 20, bottom: index * 20 + 18, width: 120, height: 18 }) as DOMRect;
  });
  viewer.getBoundingClientRect = () => ({ top: 0, bottom: 80, width: 500, height: 80 }) as DOMRect;
  Object.defineProperty(viewer, "scrollTop", { value: 0, writable: true });
  const calls: ScrollToOptions[] = [];
  viewer.scrollTo = ((options: ScrollToOptions) => { calls.push(options); }) as typeof viewer.scrollTo;

  expect(CmuxViewerNavigation.moveRenderedRow!(viewer, 1)).toEqual({ lineNumber: 11, side: "additions" });
  expect(calls).toEqual([{ top: 8, behavior: "smooth" }]);
});

test("rendered-row navigation resolves the newly materialized row at a Pierre window boundary", () => {
  dom = new JSDOM("<!doctype html><html><body><div id='viewer'><div id='host'></div></div></body></html>");
  const viewer = dom.window.document.getElementById("viewer") as HTMLElement;
  const host = dom.window.document.getElementById("host") as HTMLElement;
  host.dataset.cmuxReviewItemId = "file-a";
  const root = host.attachShadow({ mode: "open" });
  const selected: unknown[] = [];
  viewer.addEventListener("cmux-diff-viewer-rendered-row-selected", (event) => {
    selected.push((event as CustomEvent).detail);
  });
  const renderWindow = (lineNumbers: number[]) => {
    root.innerHTML = lineNumbers.map((lineNumber) => `<div data-line='${lineNumber}'></div>`).join("");
    Array.from(root.querySelectorAll<HTMLElement>("[data-line]")).forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 20, bottom: index * 20 + 18, width: 120, height: 18 }) as DOMRect;
    });
  };
  renderWindow([10, 11, 12]);
  viewer.getBoundingClientRect = () => ({ top: 0, bottom: 80, width: 500, height: 80 }) as DOMRect;
  Object.defineProperties(viewer, {
    clientHeight: { value: 80 },
    scrollHeight: { value: 400 },
    scrollTop: { value: 0, writable: true },
  });
  viewer.scrollTo = ((options: ScrollToOptions) => {
    viewer.scrollTop = Number(options.top);
    if (viewer.scrollTop >= 50) {
      renderWindow([11, 12, 13]);
    }
  }) as typeof viewer.scrollTo;

  expect(CmuxViewerNavigation.moveRenderedRow!(viewer, 1)).toMatchObject({ lineNumber: 11 });
  expect(CmuxViewerNavigation.moveRenderedRow!(viewer, 1)).toMatchObject({ lineNumber: 12 });
  expect(CmuxViewerNavigation.moveRenderedRow!(viewer, 1)).toEqual({ pending: true });
  expect(CmuxViewerNavigation.hasPendingRenderedRowMove!(viewer)).toBe(true);
  expect(CmuxViewerNavigation.refreshRenderedRows!(viewer)).toBe(true);
  expect(CmuxViewerNavigation.hasPendingRenderedRowMove!(viewer)).toBe(false);
  expect(selected).toEqual([
    { itemId: "file-a", lineNumber: 11, side: "additions" },
    { itemId: "file-a", lineNumber: 12, side: "additions" },
    { itemId: "file-a", lineNumber: 13, side: "additions" },
  ]);
  expect(root.querySelectorAll("[data-line]")).toHaveLength(3);
});

function shortcut(key: string, modifiers: Record<string, boolean> = {}) {
  return { first: { key, command: false, control: false, option: false, shift: false, ...modifiers } };
}

function chord(first: string, second: string) {
  return { first: shortcut(first).first, second: shortcut(second).first };
}
