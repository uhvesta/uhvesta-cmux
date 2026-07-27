import type { DiffResponse } from "./diff/generated/protocol";

export {};

type AgentSessionNativeReply =
  | { ok: true; value: unknown }
  | { ok: false; error?: { code?: string; userMessage?: string } };

declare global {
  var CmuxViewerNavigation: {
    install(options: {
      target: Document | HTMLElement;
      getScroller: () => HTMLElement;
      shortcuts: Record<string, unknown>;
    }): () => void;
    installManualInputReset(options: {
      target: Document | HTMLElement;
      getScroller: () => HTMLElement;
    }): () => void;
    hasPendingRenderedRowMove?(scroller: HTMLElement | null): boolean;
    performAction(action: string, scroller: HTMLElement): boolean;
    refreshRenderedRows?(scroller: HTMLElement | null): boolean;
    resetSmoothTarget(scroller: HTMLElement): void;
    moveRenderedRow?(scroller: HTMLElement | null, direction: -1 | 1):
      | { itemId?: string; lineNumber: number; side: "additions" | "deletions" }
      | { pending: true }
      | false;
  };

  interface Window {
    __cmuxPerformDiffViewerNavigationAction?: (action: string) => boolean;
    __cmuxDiffViewer?: {
      codeView?: unknown;
      codeViewItems?: unknown[];
      items?: unknown[];
      state?: unknown;
      streamMetrics?: unknown;
      workerPool?: unknown;
    };
    webkit?: {
      messageHandlers?: {
        agentSession?: {
          postMessage(message: unknown): Promise<AgentSessionNativeReply>;
        };
        cmuxDiff?: {
          postMessage(message: unknown): Promise<DiffResponse>;
        };
      };
    };
  }
}
