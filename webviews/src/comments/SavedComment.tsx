import { useState } from "react";
import { CommentComposer } from "./CommentComposer";
import { commentDisplayName } from "./format";
import type { DiffCommentLabels } from "./labels";
import type { DiffCommentRecord } from "./types";
import { isAskComment } from "../review-prompt";

export function SavedComment({
  comment,
  labels,
  onDelete,
  onSaveMessage,
  forceEditing = false,
  replies = [],
}: {
  comment: DiffCommentRecord;
  labels: DiffCommentLabels;
  onDelete: () => void;
  onSaveMessage: (message: string) => void;
  forceEditing?: boolean;
  replies?: readonly DiffCommentRecord[];
}) {
  const [editing, setEditing] = useState(false);
  const isReviewQuestion = isAskComment(comment);
  const editingNow = editing || forceEditing;
  if (editingNow && !comment.readOnly && !isReviewQuestion) {
    return (
      <CommentComposer
        initialMessage={comment.message}
        labels={labels}
        allowEmpty
        onCancel={() => setEditing(false)}
        onSave={(message) => {
          onSaveMessage(message);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="comment-card" data-comment-id={comment.id} data-read-only={comment.readOnly ? "true" : undefined}>
      <div className="comment-card-header">
        <span className="comment-card-location">{commentDisplayName(comment)}</span>
        {!comment.readOnly ? (
          <span className="comment-card-actions">
            {!isReviewQuestion ? (
              <button type="button" className="comment-card-action" onClick={() => setEditing(true)}>
                {labels.editComment}
              </button>
            ) : null}
            <button type="button" className="comment-card-action" onClick={onDelete}>
              {labels.deleteComment}
            </button>
          </span>
        ) : null}
      </div>
      <div className="comment-card-message">{comment.message}</div>
      {replies.length > 0 ? (
        <div className="comment-card-replies">
          {replies.map((reply) => (
            <div key={reply.id} className="comment-card-reply" data-comment-id={reply.id} data-read-only="true">
              <div className="comment-card-reply-author">
                {labels.answerFrom.replace("{author}", reply.author || "GitHub Copilot")}
              </div>
              <div className="comment-card-message">{reply.message}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
