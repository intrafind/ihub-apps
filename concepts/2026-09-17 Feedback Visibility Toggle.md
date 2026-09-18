# Feedback Visibility Toggle

Status: **implemented** — shipped in `feat/feedback-visibility-toggle` (3 commits: `b597642e` feature, `00322cbf` + `4dcd9d7c` review-driven and manual-testing-driven fixes, see [Review Findings & Fixes](#review-findings--fixes) below).

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
- Client: `ChatMessageList.jsx` reads the resolved flag inline as `useFeatureFlags().isEnabled('feedback', true)`, matching how every other platform-level flag is checked in this codebase (`ChatInput.jsx`, `WorkflowMentionSearch.jsx`, etc.). The spec originally called for "a small dedicated hook... following the established one-hook-per-flag idiom used for other flags" — code review found that idiom doesn't actually exist anywhere else in the codebase (every other consumer inlines `isEnabled(...)`), so the dedicated `useFeedbackEnabled()` hook that was first built was removed in favor of the inline call. See [Review Findings & Fixes](#review-findings--fixes).
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

**Status:** done

- [x] New registry entry `feedback` in `server/featureRegistry.js` (`category: 'content'`, `default: true`, `en`/`de` name + description, no `preview` flag)
- [x] `POST /api/feedback` (`server/routes/chat/feedbackRoutes.js`) gated with `requireFeature('feedback')`
- [x] Client reads the resolved flag from the platform-config context — inline `useFeatureFlags().isEnabled('feedback', true)` in `ChatMessageList.jsx`, not a dedicated hook (see [Review Findings & Fixes](#review-findings--fixes))
- [x] Flag threaded as a prop through the shared message-list wrapper into `ChatMessage`, gating both the inline star-rating row and the feedback modal behind the one prop
- [x] No config migration added — confirmed unnecessary: the Feature Registry resolves the missing key to `default: true` for existing installations
- [x] Server integration test: `POST /api/feedback` → 403 `FEATURE_DISABLED` when disabled, normal (2xx) behavior when enabled — real route request, following the pattern in `server/tests/oauth-connections.test.js` (`server/tests/feedback-visibility.test.js`)
- [x] Client render test under `tests/unit/client/`: feedback controls absent from `ChatMessage`/`ChatMessageList` output when disabled, present when enabled — component-render level, following the pattern in `chat-component.test.jsx` (`tests/unit/client/chat-message-feedback-visibility.test.jsx`)
- [x] `docs/feedback-feature.md` corrected: clarify that `features.feedbackTracking` is storage-only (not a UI-visibility toggle), and add a short section documenting the new `feedback` registry flag — corrected twice, see [Review Findings & Fixes](#review-findings--fixes) (the first pass still pointed at the wrong config file)
- [x] Changelog entry added under `docs/releases/next/` via the `/document-feature` skill (admin-visible feature addition)
- [x] `npm run lint:fix && npm run format:fix` run clean before commit
- [x] Admin Usage Reports feedback analytics verified unaffected (no regression — out of scope for changes, confirmed nothing broke)

## Review Findings & Fixes

A `/code-review high` pass (8 finder angles, 1-vote verification) ran against the diff after the initial implementation (`b597642e`). Findings were triaged and mostly fixed in a follow-up commit (`00322cbf`); manually verifying the shipped feature end-to-end in Docker then surfaced one more, unrelated bug, fixed in a second follow-up commit (`4dcd9d7c`).

**Fixed (`00322cbf`):**

- **Docs pointed at the wrong config file.** `docs/feedback-feature.md` told admins to set the new flag via `contents/config/platform.json`; the server actually reads it from `contents/config/features.json` (`configCache.getFeatures()`, a flat top-level key — same file as `skills`, `workflows`, etc.). Following the doc's own example literally would have had no effect. Corrected the table, the JSON example, and added a matching Troubleshooting entry for the new `403 FEATURE_DISABLED` failure mode (the old Troubleshooting section only covered the unrelated `feedbackTracking` silent-non-persistence case).
- **The "one-hook-per-flag idiom" didn't exist.** `useFeedbackEnabled()` (in `useFeatureFlags.js`) claimed to follow an established codebase pattern that a repo-wide grep showed doesn't exist — every other flag consumer inlines `useFeatureFlags().isEnabled(id, default)`. Removed the dedicated hook; `ChatMessageList.jsx` now inlines the check like everywhere else. This also removed a triplicated `true` default (registry entry, hook, and `ChatMessage`'s prop default all hardcoded it independently with nothing keeping them in sync).
- **Modal could silently reappear.** `ChatMessage.jsx`'s `showFeedbackForm` state was never reset when `feedbackEnabled` turned false — the modal only stopped *rendering* (via the new prop guard), so if the flag flipped back on before the user closed it another way, the modal could reappear on its own. Added a `useEffect` that resets `showFeedbackForm` when `feedbackEnabled` becomes false.

**Deliberately not changed** (reported, reasoning recorded so it isn't re-litigated):

- `requireFeature('feedback')` runs before `authRequired` in `feedbackRoutes.js`, so an unauthenticated request gets `403 FEATURE_DISABLED` instead of `401` while the flag is off. Matches the majority existing convention in this codebase (`toolRoutes.js`, `dataRoutes.js`'s `/api/prompts`, all `integrations/*.js` routers) — not a regression specific to this feature.
- `server/package-lock.json`'s version field changed `5.4.13` → `5.5.9` in the same diff. Unrelated to this feature (syncs the lockfile to a version `package.json` already had from an earlier, separate release-bump commit); reverting it would reintroduce that inconsistency, so left as-is.
- The `StarRating` test mock in `chat-message-feedback-visibility.test.jsx` uses one non-unique `data-testid` even though `ChatMessage` renders `StarRating` twice (trigger row + modal). No current test opens the modal, so this doesn't fail today — latent fragility for whoever writes that test next, not fixed pre-emptively.

**Found during manual Docker verification, fixed in a second follow-up (`4dcd9d7c`):**

- **`POST /api/feedback` rejected every normal submission with 400**, unrelated to the visibility flag itself. `server/validators/index.js`'s `feedbackSchema` declared `conversationId`/`ifinderMessageId` as `z.string().optional()`, which in Zod v4 accepts `undefined` but not `null` — and the client (`ChatMessage.jsx`) explicitly sends `null` for both whenever there's nothing to report (e.g. no `conversationId` yet in `localStorage` on a fresh install, or a non-iFinder message). Pre-existing bug, surfaced only because verifying this feature required actually submitting feedback end-to-end for the first time in a while. Fixed with `.nullable().optional()`, matching the existing pattern in `auditEntrySchema.js`. Regression test added: `tests/unit/server/feedbackSchema.test.js`.

## Further Notes

- Admin-panel placement (Content category) and the relationship to the existing storage-only flag (kept independent, not consolidated) were explicitly confirmed with the requester.
- Full grilling history and decision rationale for this feature (rounds Q1–Q7) live in the originating chat thread; no separate `CONTEXT.md` paper trail exists since that session used the stateless grilling entry point. `CONTEXT.md` is not part of iHub's own conventions and was not introduced for this feature.
- No `docs/agents/issue-tracker.md` triage-label workflow applies here — this spec is published as a local `concepts/` file per iHub's own convention (`CLAUDE.md` → "Design/planning docs go in `concepts/` as `YYYY-MM-DD {title}.md`"), not to an external issue tracker.
