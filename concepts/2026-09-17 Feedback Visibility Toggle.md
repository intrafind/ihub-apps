# Feedback Visibility Toggle

Status: **ready-for-agent** (spec approved, not yet implemented)

## Problem Statement

Admins currently have no way to prevent end users from submitting response feedback (star rating + comment) via the chat UI. Feedback controls are hard-coded into `ChatMessage.jsx` and are always visible to every user in every chat surface (main chat, compare mode, canvas, Office add-in). An admin who wants to disable feedback collection — for compliance, to reduce noise, or because the org doesn't use it — has no supported way to hide it; the only existing related flag (`features.feedbackTracking`) only stops server-side storage, not UI visibility or submission.

## Solution

Add a new platform-wide feature flag `feedback` to the existing Feature Registry (the same mechanism that powers `skills`, `workflows`, `compareMode`, etc.), exposed as a toggle in the admin Features panel (Content category). When disabled: the feedback UI (star rating row + submission modal) is hidden from all users everywhere `ChatMessage` renders, and the `POST /api/feedback` endpoint is locked server-side (403 `FEATURE_DISABLED`), so feedback cannot be submitted even via direct API calls. Default is enabled (`true`), preserving current behavior for all existing installations until an admin opts out.

## User Stories

1. As an admin, I want to disable the feedback feature for all users, so that no one in my organization can submit response feedback anymore.
2. As an admin, I want to re-enable feedback at any time, so that I can turn it back on if organizational needs change.
3. As an admin, I want the feedback toggle to live in the existing Features admin panel, so that I don't have to hunt for a new settings page.
4. As an end user, when feedback is disabled, I want to no longer see the star-rating control under AI responses, so that the UI isn't cluttered with an option I can't use.
5. As an end user, when feedback is disabled, I want the feedback modal to be unreachable, so that I cannot accidentally trigger a submission flow that will fail.
6. As an end user in Compare Mode, when feedback is disabled, I want feedback controls hidden on both compared responses, so the experience is consistent with the main chat.
7. As an end user in the Canvas view, when feedback is disabled, I want feedback controls hidden there too, so there's no inconsistency across surfaces.
8. As an Office Add-in user, when feedback is disabled, I want feedback controls hidden in the Office chat panel, so the same rule applies regardless of host.
9. As an API consumer, when feedback is disabled, I want `POST /api/feedback` to reject with 403, so that disabling the feature can't be bypassed by calling the API directly.
10. As an admin, I want the toggle to apply equally to admin accounts, so that behavior is predictable, with no special-casing.
11. As an admin, I want already-submitted feedback to remain visible in the Usage Reports "Feedback" analytics, so that disabling future submissions doesn't destroy historical insight.
12. As an admin, I want the new toggle to be independent of the existing `features.feedbackTracking` storage flag, so that "visibility" and "persistence" remain separately controllable concerns.
13. As an admin on an existing (upgraded) installation, I want feedback to remain enabled by default after upgrading, so the new feature doesn't silently change my current setup without action on my part.
14. As a platform maintainer, I want the new flag documented in the admin changelog ("What's New"), so admins upgrading are aware the control exists.
15. As a platform maintainer, I want the existing `docs/feedback-feature.md` corrected where it currently describes `features.feedbackTracking` as a UI-hiding toggle, so the docs don't mislead admins about what that flag actually does.

## Implementation Decisions

- New entry in `server/featureRegistry.js`: `id: 'feedback'`, `category: 'content'`, `default: true`, with `en`/`de` name and description. No `preview` flag — a stable capability, not a preview one.
- No new admin page/component needed: the existing generic Features admin page and admin API already render and persist any registry entry automatically.
- Server: the feedback submission route gets `requireFeature('feedback')` inserted into its middleware chain, following the same pattern already used by `tools`, `sources`, `skills`, and other gated routes. The disabled state returns the standard 403 `{ error, code: 'FEATURE_DISABLED' }` response already produced by the shared `requireFeature` middleware — no bespoke error handling needed.
- Client: a small dedicated hook reads the resolved flag from the existing platform-config context (the same context that already exposes a per-feature boolean lookup), following the established one-hook-per-flag idiom used for other flags.
- The shared chat message rendering component receives the resolved boolean as a prop, threaded through the shared message-list wrapper, following the exact precedent already used for another optional per-message capability threaded the same way. Both the inline rating control and the feedback submission modal are conditioned on this single prop — one seam, not two independent checks.
- Because this is a single shared component used by every chat surface (main chat, compare mode, canvas, Office add-in), gating it once at that shared layer covers every surface without surface-specific changes.
- The pre-existing, unrelated storage-only flag stays untouched and independent; it is not renamed, removed, or merged into the new flag. A doc correction (below) clarifies the distinction.
- No config migration is required: the Feature Registry resolves any absent key to its declared default at read time, so existing installations automatically get `feedback: true` without a migration step.
- Admin-facing historical feedback analytics are unaffected by this flag — it only gates new submissions, not the display of previously collected data.
- Documentation: correct the existing feedback-feature doc's configuration section to stop describing the storage-only flag as a UI toggle, and add a short section describing the new admin-facing visibility toggle. A changelog entry is added under `docs/releases/next/` (via the `/document-feature` skill), since this is an admin-visible feature addition.

## Testing Decisions

- Good tests here assert observable behavior, not implementation: for the server, that the endpoint returns 403 with the flag disabled and 2xx with it enabled — not that a specific middleware function was called. For the client, that the rating control and modal are absent from the rendered output when disabled, and present when enabled — not that a particular prop was passed.
- **Server seam**: integration-level test against the actual `POST /api/feedback` route (request → response), following the existing precedent of testing a feature-gated route by toggling the resolved feature config and asserting the status/error code (same shape already used for other feature-gated integration tests, e.g. `server/tests/oauth-connections.test.js`).
- **Client seam**: a render test of the shared chat message component (or its list wrapper) under `tests/unit/client/`, following the precedent of the existing chat-component render tests there (e.g. `chat-component.test.jsx`) — render with the flag on and off, assert presence/absence of the feedback controls in each case, using the existing Testing-Library-based conventions.
- Out of scope for new tests: the generic Feature Registry resolution mechanism and the generic admin Features CRUD API — pre-existing, already-covered infrastructure being reused, not new behavior.

## Out of Scope

- Per-app or per-group override of the feedback flag (global-only for this iteration).
- Any change to how already-submitted feedback is stored, retained, or displayed in admin analytics.
- Any change to the existing, separate storage-only feedback flag's behavior (only its documentation is corrected).
- A confirmation dialog or "why is this disabled" explanatory UI for end users — the control is simply absent, no messaging is added.
- Changes to iFinder/iAssistant feedback-forwarding behavior beyond the fact that forwarding can no longer be triggered once submission itself is blocked.

## Implementation Ticket

Single tracer-bullet ticket — the feature is small enough to fit one context window, so no split and no blocking edges are needed.

**What to build:** An admin can turn "Feedback" off in the Features panel (Content category). Once off, every user loses the star-rating control and feedback modal everywhere `ChatMessage` renders (main chat, compare mode, canvas, Office add-in), and `POST /api/feedback` rejects with 403. Turning it back on restores both immediately. Default is on, so no existing installation's behavior changes until an admin acts.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] New registry entry `feedback` in `server/featureRegistry.js` (`category: 'content'`, `default: true`, `en`/`de` name + description, no `preview` flag)
- [ ] `POST /api/feedback` (`server/routes/chat/feedbackRoutes.js`) gated with `requireFeature('feedback')`
- [ ] New client hook (e.g. `useFeedbackEnabled()`) reading the resolved flag from the platform-config context, following the existing one-hook-per-flag idiom
- [ ] Flag threaded as a prop through the shared message-list wrapper into `ChatMessage`, gating both the inline star-rating row and the feedback modal behind the one prop
- [ ] No config migration added — confirmed unnecessary: the Feature Registry resolves the missing key to `default: true` for existing installations
- [ ] Server integration test: `POST /api/feedback` → 403 `FEATURE_DISABLED` when disabled, normal (2xx) behavior when enabled — real route request, following the pattern in `server/tests/oauth-connections.test.js`
- [ ] Client render test under `tests/unit/client/`: feedback controls absent from `ChatMessage`/`ChatMessageList` output when disabled, present when enabled — component-render level, following the pattern in `chat-component.test.jsx`
- [ ] `docs/feedback-feature.md` corrected: clarify that `features.feedbackTracking` is storage-only (not a UI-visibility toggle), and add a short section documenting the new `feedback` registry flag
- [ ] Changelog entry added under `docs/releases/next/` via the `/document-feature` skill (admin-visible feature addition)
- [ ] `npm run lint:fix && npm run format:fix` run clean before commit
- [ ] Admin Usage Reports feedback analytics verified unaffected (no regression — out of scope for changes, but confirm nothing broke)

## Further Notes

- Admin-panel placement (Content category) and the relationship to the existing storage-only flag (kept independent, not consolidated) were explicitly confirmed with the requester.
- Full grilling history and decision rationale for this feature (rounds Q1–Q7) live in the originating chat thread; no separate `CONTEXT.md` paper trail exists since that session used the stateless grilling entry point. `CONTEXT.md` is not part of iHub's own conventions and was not introduced for this feature.
- No `docs/agents/issue-tracker.md` triage-label workflow applies here — this spec is published as a local `concepts/` file per iHub's own convention (`CLAUDE.md` → "Design/planning docs go in `concepts/` as `YYYY-MM-DD {title}.md`"), not to an external issue tracker.
