# Per-action approval with fingerprints (#2916): implementation notes

**Date:** 2026-11-02
**Status:** Implemented (draft PR, stacked on the tool approval PR #3136)
**Issue:** [intrafind/ihub-apps#2916](https://github.com/intrafind/ihub-apps/issues/2916) · also the fingerprint part of [#2913](https://github.com/intrafind/ihub-apps/issues/2913)
**Builds on:** [2026-11-02 Tool approval.md](2026-11-02%20Tool%20approval.md) (#2945)
**User docs:** [docs/tool-approval.md → New and changed actions](../../docs/tool-approval.md#new-and-changed-actions)

These notes say where things are and why, for whoever continues this (the Actions tab and action
detail of #2974 are the next consumers).

## What this adds on top of #2945

1. **Fingerprints** of every action of an installation: `sha256:` over name, the vendor's
   declared side effect and the canonical input schema.
2. **`approval.newOrChanged`** (default `always`): an action whose name is not among the accepted
   fingerprints (`new`) or whose fingerprint differs (`changed`) resolves to at least this mode
   until an admin marks it reviewed.
3. **Badges** "New" / "Changed" on the installation Overview, **Mark reviewed** per action and
   **Mark all reviewed** (audited).
4. **`actions.overrides[action].dataFlow`** (the `sideEffect` override existed); the resolver
   reads both.
5. **Install form preselection:** `writes`, or `always` for external integrations without trusted
   side effects.
6. A test that an app cannot loosen an **action** mode (the installation-default case was tested
   in #3136).

No config migration: every new field is optional and absent has a meaning (no baseline, `always`).
V208 was not used.

## Where the pieces are

| Piece | File | Notes |
| --- | --- | --- |
| Fingerprint, canonical schema, review state | `server/utils/actionFingerprint.js` | Pure. `actionReviewState(installation, name, fingerprint)` → `new` / `changed` / null. |
| Resolver layer | `server/utils/toolApproval.js` | After the action mode, before the app. Source `newOrChanged`. Also `resolveDataFlow(tool, installation)`. |
| Discovery hook | `server/services/integrations/actionReview.js` | `fingerprintsOfActions`, `fingerprintOfTool` (MCP/A2A), `currentActionsOf`, `observeActionFingerprints`. |
| Tool loader | `server/services/integrations/integrationTools.js` → `discoverIntegrationTools` | Puts `_integration.fingerprint` on every integration tool and observes in the background. |
| Store | `InstalledIntegrationService.recordActionBaseline` / `markActionsReviewed` | `update()` keeps the stored fingerprints; `_prepare` strips them from any payload. |
| Schema | `server/validators/integrationsConfigSchema.js` | `actions.fingerprints`, `actions.reviewedAt`, `approval.newOrChanged`, override `dataFlow`. |
| Definition migrations | `migrationPlanner.js` → `materialize` | Keeps fingerprints, `reviewedAt` and `newOrChanged`. A renamed action is new under its new name. |
| Admin API | `routes/admin/integrations.js` | `GET …/installed/:id` adds `review` per action and takes the baseline; `PUT …/approval` takes it when approval is turned on; `POST …/installed/:id/actions/review`. Catalog detail has `approvalPreset`. |
| Preset | `shared/toolApproval.js` → `installApprovalPreset` | Computed on the server (`approvalPreset`), with a client fallback for older payloads. |
| Client | `ActionReviewBadge.jsx` (shared `Badge`), `AdminInstallationPage.jsx`, `installationApproval.js` (`withNewOrChangedMode`, `actionsPendingReview`), `IntegrationInstallForm.jsx`, `integrationsAdminApi.js` | en + de in `shared/i18n`. |

## Decisions and why

- **What is fingerprinted.** Name + declared side effect + canonical schema, as the issue and
  the architecture concept say. The *declared* side effect, never the admin override: the
  override is the admin's own decision and must not make an action look changed. Descriptions
  and titles are dropped from the schema because iHub localises them per request language;
  otherwise every language would be a different fingerprint. Property *names* called
  `description` / `title` are kept (only keywords are dropped).
- **Only reviewed fingerprints are stored.** "New" and "changed" are derived on every
  resolution, so discovery never needs to write. The file is written in three cases only: the
  one-time baseline, "Mark reviewed", and the admin save paths that already wrote.
- **Opt-in.** The baseline is taken only for an installation that has an `approval` object, and
  the resolver applies `newOrChanged` only then. Installations without approval never get a
  write or a gate — "nothing changes until an admin sets a mode".
- **Baseline only from complete lists.** For MCP and A2A, the chat path sees only the tools that
  are switched on (`discoverTools`); a baseline from that would badge every switched-off tool as
  new. So the chat path only compares for those; the baseline comes from the admin views
  (`discoverActions` with `includeUnavailable`). Native and OpenAPI adapters list every action in
  the chat path too (`includeUnavailable: true`), so either path can take it. An empty list never
  becomes a baseline (a per-user MCP server's catalog may be empty until someone connects).
- **Errored actions have no fingerprint** (OpenAPI operation missing, connector not implementing
  it): their schema is a placeholder.
- **Both paths agree.** The MCP tool and the MCP admin listing come from the same raw
  `tools/list` entry (`inputSchema`, annotations); A2A tools and actions differ only in
  descriptions. Tests pin both (`server/tests/loop/actionFingerprint.test.js`).
- **Reporting.** A new or changed action is logged once per worker, installation, action and
  fingerprint (`ActionReview` warning). This is the "changed fingerprint is reported" of #2913.
- **Preset.** "Trusted annotations" do not exist in iHub's resolver (#2945 decided annotations
  never relax a gate), so "external without trusted annotations" means: dynamic actions (MCP,
  A2A), or an external definition action with side effect `unknown`.
- **Migration of #2945's per-tool / per-server config** (issue acceptance criterion): nothing to
  migrate. #2945 shipped in the same release directly on installations
  (`installed[].approval`); tool files keep their own `approval`.

## Known limits / follow-ups

- **Settings that shape the schema.** An OpenAPI action's input depends on the installation's
  values (a `cap` default like CKAN's `maxRows` becomes `maximum`). Changing such a value makes
  the action "changed". Documented; the admin is on the page anyway. If this turns out to be
  noisy, fingerprint the schema before `shapeParametersForModel`.
- **Actions tab and action detail (#2974)** should show the same `review` state and the
  per-action review; the API is ready (`GET …/installed/:id` → `actions[].review`, `POST
  …/actions/review`).
- **No UI for the `sideEffect` / `dataFlow` overrides** yet (config only, as before); #2974.
- **Multi-worker:** each worker reports once; the baseline write is serialised per worker and is
  idempotent (a second write finds the baseline and does nothing).
- The approval card does not yet say *why* it asks ("new since your last review"); the stamp's
  `approvalSource` is `newOrChanged`, so the card could show it.
