import { useCallback, useState } from "react";
import type { DiffCommentLabels } from "./labels";

export function CommentComposer({
  initialMessage = "",
  labels,
  allowEmpty = false,
  askUnavailableMessage,
  onCancel,
  onSave,
}: {
  initialMessage?: string;
  labels: DiffCommentLabels;
  /** Editing an existing comment treats an empty save as deletion. */
  allowEmpty?: boolean;
  /** Shown for SSH reviews, which have no local checkout for the Copilot sidecar. */
  askUnavailableMessage?: string;
  onCancel: () => void;
  onSave: (message: string) => void;
}) {
  const [message, setMessage] = useState(initialMessage);
  const focusOnMount = useCallback((node: HTMLTextAreaElement | null) => {
    node?.focus();
  }, []);
  return (
    <div className="comment-composer">
      <textarea
        ref={focusOnMount}
        className="comment-composer-input"
        placeholder={labels.commentPlaceholder}
        aria-label={labels.addComment}
        rows={3}
        value={message}
        onChange={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && (allowEmpty || message.trim() !== "")) {
            event.preventDefault();
            onSave(message);
          }
        }}
      />
      <div className="comment-composer-footer">
        <span />
        <span className="comment-composer-buttons">
          <button type="button" className="comment-button" onClick={onCancel}>
            {labels.cancelComment}
          </button>
          <button
            type="button"
            className="comment-button comment-button-primary"
            disabled={!allowEmpty && message.trim() === ""}
            onClick={() => onSave(message)}
          >
            {labels.saveComment}
          </button>
        </span>
      </div>
      {askUnavailableMessage ? <div className="comment-composer-hint">{askUnavailableMessage}</div> : null}
    </div>
  );
}
