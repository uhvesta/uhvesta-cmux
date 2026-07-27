# Review Tab Decoupling Plan

## Goal

Make the review feature a low-maintenance overlay that can survive continued
upstream cmux development with minimal merge conflicts. Preserve the current
behavior while moving feature ownership out of large, frequently changed cmux
files.

## Current assessment

The implementation has sound integration choices:

- It extends the existing diff viewer instead of introducing another review UI.
- It preserves the existing TextBox comment-delivery pipeline.
- Aggregate review and SSH share a versioned manifest boundary.
- Copilot uses the existing ACP adapter and leaves ordinary chat behavior intact.
- Base-ref settings layer over the existing detection chain.

The main maintenance risk is integration breadth. Review behavior currently
touches large or frequently evolving files such as `webviews/src/App.tsx`,
`Sources/Panels/DiffCommentsBridge.swift`, `Sources/AppDelegate.swift`, settings
plumbing, shortcuts, and CLI parsing. These are likely conflict points when
rebasing onto upstream cmux.

## Target boundaries

### 1. Review workspace model

Introduce a cohesive model that owns:

- Local and SSH review sources.
- Aggregate repository manifests.
- Canonical repository identity.
- Per-repository base refs.
- File and stable hunk identity.
- Direct file/hunk landing requests.

Both local discovery and the SSH companion should produce the same versioned
model. UI code should not infer repository ownership from file paths.

### 2. Comment repository

Hide SQLite and submission-pool details behind a review-specific interface:

- Global and workspace-scoped reads and writes.
- Scope-qualified comment identity.
- Line-content re-anchoring.
- Question/answer relationships.
- Pending feedback bundles and consumption.
- Migrations from legacy JSON and earlier SQLite schemas.

Callers should always provide an explicit stable workspace scope and canonical
repository identity.

### 3. Review question coordinator

Extract `/ask` ownership from the webview bridge:

- One-shot Copilot request lifecycle.
- Read-only sandbox policy.
- Request persistence and restart recovery.
- Cancellation and deletion.
- Completion/failure events and notifications.
- Remote-review capability checks.

The native bridge should translate messages only; it should not own asynchronous
question state.

### 4. Review web modules

Move review behavior out of the root React application into focused modules:

- Aggregate repository tree and section rendering.
- Full File expansion state and per-hunk controls.
- Stable hunk navigation and direct landing.
- Comment composition and annotation anchoring.
- Review prompt generation, Copy, and Send.
- Native bridge protocol and localized label contract.

`App.tsx` should primarily compose these modules and route top-level state.

## Thin cmux integration surface

After extraction, core cmux should need only:

- One review-tab action registration.
- Shortcut action registrations.
- One panel/bridge registration.
- One CLI command registration.
- Settings keys and host adapters.
- One Copilot provider catalog entry.

Avoid duplicating review rules in these entry points. They should call shared
actions or coordinators.

## Suggested migration sequence

1. Freeze the current behavior with end-to-end tests and finish the active
   convergence audit.
2. Define the versioned review workspace/manifest model and convert local and
   SSH producers to it.
3. Extract the comment repository and make every mutation scope-explicit.
4. Extract the question coordinator, including durable restart recovery.
5. Split React review state and components out of `App.tsx`.
6. Reduce the native bridge to validation, serialization, and coordinator calls.
7. Remove duplicated compatibility paths after migrations are proven.

Each step should preserve behavior and be independently buildable. Do not mix
the refactor with new review features.

## Completion criteria

- Review-specific behavior is testable without launching the full app.
- Local and remote reviews use one canonical manifest model.
- No repository ownership is inferred from display paths.
- Comment and question operations require explicit workspace/repository scope.
- `App.tsx` and `DiffCommentsBridge.swift` contain only thin integration code.
- Ordinary terminal, browser, agent-chat, and Copilot behavior remains unchanged.
- Updating upstream cmux generally affects registration points, not review
  internals.
- A rebase conflict audit shows the feature concentrated in review-owned files.

