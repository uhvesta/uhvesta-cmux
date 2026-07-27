import { describe, expect, test } from "bun:test";
import { createDiffViewerLabelResolver } from "../src/labels";

describe("createDiffViewerLabelResolver", () => {
  test("uses localized payload labels first", () => {
    const label = createDiffViewerLabelResolver({ hideFiles: "Hide changed files" });

    expect(label("hideFiles")).toBe("Hide changed files");
  });

  test("falls back to shipped default labels instead of raw keys", () => {
    const label = createDiffViewerLabelResolver(undefined);

    expect(label("hideFiles")).toBe("Hide files");
  });

  test("fails fast for missing payload labels in development mode", () => {
    const label = createDiffViewerLabelResolver(undefined, { assertMissing: true });

    expect(() => label("hideFiles")).toThrow("Missing cmux diff viewer label: hideFiles");
  });

  test("deduplicates missing payload label assertions", () => {
    const label = createDiffViewerLabelResolver(undefined, { assertMissing: true });

    expect(() => label("hideFiles")).toThrow("Missing cmux diff viewer label: hideFiles");
    expect(label("hideFiles")).toBe("Hide files");
  });

  test("falls back to defaults for empty payload labels", () => {
    const label = createDiffViewerLabelResolver({ hideFiles: "  " });

    expect(label("hideFiles")).toBe("Hide files");
  });

  test("new review surfaces are part of the required native payload contract", () => {
    const label = createDiffViewerLabelResolver({
      copyFailedReviewPrompt: "Could not copy review prompt",
      copiedReviewPrompt: "Copied",
      copyReviewPrompt: "Copy",
      answerFrom: "Answer from {author}",
      askComment: "Ask Copilot",
      askImmutable: "Immutable",
      askUnavailableRemote: "Unavailable remotely",
      fullFile: "Full File",
      queuedReviewPrompt: "Queued",
      repository: "Repository",
      sendReviewPrompt: "Send",
      sendReviewPromptFailed: "Failed",
      switchToFullFile: "Full",
    }, { assertMissing: true });

    expect(label("fullFile")).toBe("Full File");
    expect(label("repository")).toBe("Repository");
    expect(label("copyFailedReviewPrompt")).toBe("Could not copy review prompt");
    expect(label("sendReviewPrompt")).toBe("Send");
    expect(label("answerFrom")).toBe("Answer from {author}");
    expect(label("askUnavailableRemote")).toBe("Unavailable remotely");
  });
});
