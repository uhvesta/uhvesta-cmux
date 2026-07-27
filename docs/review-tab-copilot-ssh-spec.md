# Review Tab + Copilot + SSH Integration Spec

Status: Draft, not yet implemented.

## Summary

Extend cmux's existing native diff viewer (`cmux-diff-viewer://` `BrowserPanel`,
built on `@pierre/diffs`) rather than building a new review surface from
scratch. Keep all existing comparison modes (unified/split, base-ref/merge-base
logic) exactly as they are today — no changes there.

New work, in six areas:

1. Multi-repo aggregate review (one tab, all repos under a path).
2. Full File view mode with expandable per-hunk context.
3. Vim motions (`j`/`k`/`h`/`l`/`c`) scoped to the review panel.
4. Feedback bundled as structured markdown, delivered to the existing open
   TUI session in the tab.
5. GitHub Copilot as a first-class agent-chat provider, plus a `/ask`
   comment bridge.
6. SSH-based remote review via an on-demand companion process.

## Prior art already in the codebase (extend, don't rebuild)

| Piece | Where |
|---|---|
| Diff viewer panel (unified/split), served via `cmux-diff-viewer://` in a `BrowserPanel` | `Sources/Panels/BrowserPanel.swift`, web app `webviews/src/App.tsx` on `@pierre/diffs`/`@pierre/trees` |
| Comment model + persistence (JSON per repo, re-anchored by line content) | `Sources/DiffCommentStore.swift` |
| Comment → agent delivery pipeline (`submissionText`, pending pool, TextBox consumption) | `Sources/DiffCommentStore.swift`, `Sources/DiffCommentSubmissionPool.swift`, `Sources/TextBoxInput.swift` |
| Native JS bridge for comment CRUD from the web app | `Sources/Panels/DiffCommentsBridge.swift` |
| `cmux diff` CLI subcommand, opens the panel | `CLI/cmux_open.swift`, `CLI/cmux.swift` |
| Base-ref / merge-base comparison with `origin/HEAD` → `origin/main`/`master` → upstream fallback | `resolvedGitBranchDiffBaseRef` / `gitBranchDiffBaseRef`, `CLI/cmux_open.swift:1793-1819` |
| Vim-ish bare-key nav (`j`/`k` scroll, `]f`/`[f` next/prev file, `gg`/`G`, `/` search), scoped to panel focus | `Sources/KeyboardShortcutSettings.swift`, `Sources/KeyboardShortcutActionContext.swift` (`ShortcutContext.viewerPanel`, `allowsBareFirstStroke`) |
| Copilot CLI native ACP server mode | confirmed via `copilot --acp` |
| Reusable ACP client adapter | `agent-chat/adapters/acp.ts` (`makeAcpAdapter`), already used by the `opencode` provider in `agent-chat/server.ts` |
| Copilot recognized as a coding-agent slug (detection only, not launchable) | `Sources/CmuxTaskManagerCodingAgentDefinition+BuiltIns.swift`, `Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/AutoNamingAgentCatalog.swift` |
| Raw-SQLite wrapper precedent (no GRDB in this codebase) | `Packages/Shared/CmuxSyncStore/Sources/CmuxSyncStore/SyncDatabase.swift` |

Not native: `cmux-hub` (github.com/azu/cmux-hub) is a separate third-party
project, only linked from cmux's community showcase page
(`web/app/[locale]/(landing)/community/awesome-cmux-projects.ts`). It talks to
cmux over the existing Unix socket. Decision made: extend cmux's own viewer,
not adopt or fork cmux-hub.

## 1. Multi-repo aggregate view

- Repo discovery: given a path, walk down; at each directory, if it's a git
  repo, add it and do not recurse into its subtree; otherwise recurse into
  children. This finds sibling repos under a plain directory but never looks
  for repos nested inside a repo (no repo-in-repo discovery).
- Render every discovered repo's diff — each still computed via the existing
  per-repo base-ref/merge-base logic — inside **one review tab**, grouped by
  repo in the file tree. Not one tab per repo.
- Extend `cmux diff` / `CLI/cmux_open.swift` with a mode that accepts a
  workspace root instead of a single repo root, runs discovery, and emits one
  aggregate manifest for the web app to render (each repo's patch + metadata
  as a section).
- New entry point: shortcut opens a review tab at a path; no path given →
  current tab's cwd. New `CmuxSurfaceTabBarBuiltInAction` (`cmux.newReviewTab`)
  alongside the existing `newTerminal`/`newBrowser`/etc. cases in
  `Sources/CmuxSurfaceTabBarBuiltInAction.swift`. New keybinding — audit the
  shortcut schema before picking one; `Cmd+Shift+R` and `Cmd+1..9` are already
  taken (`renameWorkspace`, `selectWorkspaceByNumber`).

## 2. Full File view mode

- Add as a third mode alongside unified/split in `webviews/src/App.tsx`
  (`state.options.layout` currently only toggles those two).
- Base it on `@pierre/diffs`' existing `expandUnchanged` option
  (`webviews/src/pierre-options.ts`), with per-hunk expand/collapse controls
  for additions/removals rather than a single all-or-nothing toggle.
- Numbered hunks: sequential badge per file in the gutter, keyed by a stable
  hunk identity (not list index) so numbers/anchors survive a refresh.
- Full File mode can open directly at a given hunk number, or defaults to the
  first hunk.

## 3. Vim motions (all three modes)

- `j`/`k` — line up/down, every rendered row (not changed-rows-only — this
  applies in Full File mode too).
- `h`/`l` — previous/next hunk.
- `c` — add a comment on the current line/hunk, or edit if one exists;
  clearing all text deletes it.
- Implement via the existing `ShortcutContext.viewerPanel` +
  `allowsBareFirstStroke` mechanism, mirroring the already-shipped
  `diffViewerScrollDown`/`]f`/`[f`/`gg`/`G` actions. New action cases:
  `diffViewerNextHunk`, `diffViewerPreviousHunk`, `diffViewerComment`.
- Must be added to the shortcut action enum/schema, docs, and
  `web/data/cmux-shortcuts.ts` per the `cmux-keyboard-shortcuts` skill's
  cross-reference rules.

## 4. Feedback → existing TUI session, as structured markdown

- Reuse the existing pipeline end to end: `DiffComment.submissionText` →
  `DiffCommentSubmissionPool` → consumed by whichever TextBox submits next
  (`Sources/TextBoxInput.swift`). No new transport needed.
- Work needed: reformat `submissionText` generation as clean markdown — file
  path + hunk header + quoted diff context + comment text, grouped by repo
  when in the aggregate multi-repo view.
- Bundle all pending comments across all repos in the aggregate view into one
  markdown document per submission, not one per repo.
- Verify the existing "whichever TextBox submits first consumes the pool"
  behavior still makes sense from an aggregate multi-repo tab (it should be
  unchanged mechanically — just confirm during implementation).

## 5. Copilot integration

- Spike result (confirmed): `copilot --acp` runs GitHub Copilot CLI as a
  native Agent Client Protocol server.
- Add a `copilot` provider entry to `agent-chat/server.ts` using the existing
  `makeAcpAdapter` (`agent-chat/adapters/acp.ts`), same shape as the current
  `opencode` entry (`{ id: "copilot", label: "GitHub Copilot", adapter: "acp",
  cmd: ["copilot", "--acp"], installCommand: ... }`, exact install command TBD).
- Extend the existing detection-only `copilot` coding-agent-catalog entry
  (`Sources/CmuxTaskManagerCodingAgentDefinition+BuiltIns.swift`) so cmux can
  launch/manage Copilot as a full agent, not just recognize an externally
  running one.
- `/ask`-prefixed comments: route to a headless Copilot ACP session scoped to
  the relevant repo; insert the reply as a nested, read-only answer comment
  in the review tab. No multi-turn thread UI — one prompt, one answer.

## 6. SSH integration

- Goal: review repos on a remote machine without mounting or copying the
  whole tree.
- Approach: an on-demand cmux review companion process, spawned over SSH (not
  a persistent daemon), that runs the same repo-discovery + diff-computation
  logic used locally and streams the result back (JSON manifest + patch data)
  over the SSH connection via stdio — no open port required on the remote
  host.
- Once the manifest arrives, the review tab treats a remote target exactly
  like a local one — same aggregate view, same Full File/hunk/comment
  machinery. The companion is purely a data source.
- Comment delivery for remote sessions uses the same markdown-bundle
  mechanism, delivered to whichever local or remote TUI session is "current"
  for that tab.
- Non-goals for v1: no persistent remote daemon, no multi-hop SSH, no
  Windows remote hosts.

## 7. Storage

- Comments: SQLite, both a global store and workspace-scoped stores,
  replacing/extending the current per-repo JSON in `Sources/DiffCommentStore.swift`.
  Follow the existing raw-`sqlite3` wrapper pattern in
  `Packages/Shared/CmuxSyncStore/Sources/CmuxSyncStore/SyncDatabase.swift`
  rather than introducing GRDB or another dependency.
- Base-ref default: new setting, global default + per-workspace override,
  falling back to the existing `origin/HEAD` → `origin/main`/`master` →
  upstream detection chain (`CLI/cmux_open.swift:1793-1819`) when unset.

## Non-goals

- GitHub PR posting / CI status integration.
- Difftastic / structural diff mode.
- Editing source files from the review tab.
- Multi-turn chat UI for `/ask` (single prompt/answer only).
- Persistent remote daemon for SSH review.

## Suggested build order

1. Base-ref setting (small, self-contained; global default + per-workspace
   override on top of existing detection logic).
2. SQLite comment store migration (persistence only, no UI changes).
3. Multi-repo aggregate discovery + new tab/shortcut wiring.
4. Full File mode + hunk numbering + `h`/`l`/`c` shortcuts.
5. Markdown-formatted feedback bundling (builds on 2 and 3).
6. Copilot provider + `/ask` bridge.
7. SSH companion (largest, most independent piece — can start in parallel
   with 4-6 once step 3's aggregate manifest format is settled, since the SSH
   companion just needs to produce the same manifest shape remotely).

## Open questions to resolve during implementation

1. Exact keybinding for "open review tab" and Full File mode-switch — needs a
   fresh shortcut-schema audit at implementation time (bindings taken today
   may shift).
2. Whether the review tab is a new `PanelType` case or continues to live
   entirely inside `BrowserPanel` via the `cmux-diff-viewer://` scheme —
   default assumption is the latter (extend the existing browser-based
   viewer), since that's the far smaller lift; revisit only if Full File mode
   or multi-repo aggregation prove awkward to express through the webview
   bridge.
3. SQLite schema shape for comments (single table with repo/workspace scope
   columns vs. separate global/workspace databases) — decide once the
   multi-repo aggregate manifest format (step 3) is settled, since comment
   identity needs to key cleanly across repos.
4. Exact `copilot` provider `installCommand` and any auth/session bootstrap
   quirks specific to the Copilot CLI's ACP mode (not yet spiked beyond
   confirming `--acp` exists).
