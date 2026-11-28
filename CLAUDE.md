# CLAUDE.md

Canonical guidance for AI coding agents in this repository.

## Commands

```bash
npm run dev              # server + client with hot reload
npm run install:all      # deps for root, client, server
npm run lint:fix && npm run format:fix   # run before committing
npm run prod:build       # production build
npm run health           # server health check
timeout 10s node server/server.js || echo "Server startup check completed"  # verify server boots
```

Docker: see `docs/DOCKER-QUICK-REFERENCE.md` and `npm run docker:*` scripts in `package.json`.

## Architecture

Details: `docs/architecture.md`.

### Authentication

Multi-mode (anonymous, local, OIDC, proxy) with hierarchical group inheritance (`inherits` array in `groups.json`, resolved and cached at load; `admin` → `users` → `authenticated` → `anonymous`). Uses `anonymousAuth` structure, not legacy `allowAnonymous`.

Key files: `middleware/authRequired.js`, `utils/authorization.js`, `routes/auth.js`. Details: `docs/authentication-architecture.md`.

#### Default Local Admin (Dev/Testing)

Fresh `contents/` ships `admin` / `password123` via `POST /api/auth/local/login` (sets `authToken` cookie, groups `admins`, `authenticated`). Use it for e2e tests against admin endpoints — anonymous users can never pass `adminAuth`'s hard `req.user.id !== 'anonymous'` check, even with `defaultGroups: ['admins']`.

### Config System

- App schema: Zod, `server/validators/appConfigSchema.js`. Apps don't set token limits — those come from the model (`contextWindow` / `maxOutputTokens`).
- Reload behavior: platform/auth changes need a server restart; apps, models, UI, groups, projects, tools reload automatically via `configCache`.
- React pages (`contents/pages/{lang}/{id}.jsx`): component must be named `UserComponent`, receives hooks/`t`/`navigate`/`user` via props, no import/export. Details: `docs/react-component-feature.md`.
- Local LLM providers (LM Studio, Jan.ai, vLLM): OpenAI-compatible, `provider: "openai"`. See `docs/local-llm-providers.md`.

### Secret Encryption at Rest

Platform config secrets (Jira, OIDC, LDAP, Cloud Storage) are AES-256-GCM encrypted in `platform.json`; key at `contents/.encryption-key`. Encrypt on admin save, decrypt + redact on admin read, decrypt into cache at runtime. Plaintext passes through and is lazily encrypted on next save. Key files: `server/services/TokenStorageService.js`, `server/routes/admin/configs.js`, `server/configCache.js`.

## Development Rules

### When Adding New Routes ⚠️

New top-level routes in `client/src/App.jsx` MUST also be added in **both**:

1. `KNOWN_ROUTES` in `client/src/utils/runtimeBasePath.js`
2. The inline `knownRoutes` array in `client/index.html`

The lists must stay identical (`tests/unit/client/known-routes-sync.test.jsx` enforces it). Miss the `index.html` copy and a **cold load** of the route treats the route segment as the base path — the auth gate hits `/<route>/api/auth/status`, 404s, and shows "Unable to connect to the server". Test both root (`/reports`) and subpath (`/ihub/reports`) deployments with direct URL loads.

### Outbound Connections and the SSL Whitelist ⚠️

Every new outbound connection — HTTP(S), WebSocket (`wss://`), a new SDK or client library, a diagnostic probe — MUST honor `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist` (platform.json), or self-hosted endpoints with a private CA fail with "unable to verify the first certificate". Never write a bare `fetch()` / `https.request()` / `new WebSocket()` for a configurable URL:

- HTTP(S): use `httpFetch()` / `createAgent()` from `server/utils/httpConfig.js` (also applies the proxy config).
- WebSocket: merge `getWebSocketTlsOptions(url)` into the `ws` options.
- Anything else (undici dispatcher, `tls.connect`, a library with its own agent): spread `getTlsBypassOptions(url)` into its TLS options instead of writing `rejectUnauthorized: false` yourself. The bypass is host-whitelist-only; never a global switch.
- Add a test with a whitelisted and a non-whitelisted host.

### Run Activity: the Server Decides, the Client Renders

What a tool call was — a web search, a document search, a page read, a call to a connected system — and how it is labelled is decided on the server and sent with the event (`tool/started`: `title`, `integration`, `activityKind`, `activityOrigin`, from `server/utils/toolDisplay.js`; the answer's basis from `run/ended.answerBasis`). The client and `shared/run/` never infer it from a tool id; a new distinction gets a new server-sent field.

### REST API Design ⚠️

Full rules: `docs/api-guidelines.md` (use the `api-design` skill when adding or changing a route). Short form:

- Plural kebab-case nouns, camelCase query/path/body names. An operation that is not CRUD is an **`_action`** segment (`POST /tasks/{id}/_duplicate`, `POST /tasks/_preview`); never a bare verb.
- Status carries success: `201` + `Location` on create, `204` on delete, `400` (not 422) for validation. No `{ success }` / `{ message }` envelope; the top level is always an object.
- Errors: **throw** `ServiceError(code, …)` with a registry code from `shared/apiErrors.js`; never write `res.status(x).json({ error })` (inside a `try` that would catch the throw, use `sendErrorResponse(res, status, message, { code })`). The body is `application/problem+json` (RFC 9457): `type`, `title`, `status`, `detail`, `code`, optional `details` and validation `errors`; clients read `detail` and branch on `code`. OAuth/bearer errors (`error_description`) and `/v1/*` keep their own formats.
- Lists are `{ items, nextCursor }` with `limit` / `cursor`; no `page`, `offset`, `pageSize`, `after`.
- Changes are additive. Breaking an endpoint with external callers needs `Deprecation` / `Sunset` headers; ask before adding a shim.

### Observability: Spans, Metrics, Logs ⚠️

Full rules: `docs/observability-guidelines.md` (use the `observability-design` skill when implementing a feature, an outbound dependency, a tool, a background job, or touching `server/telemetry/`). Short form:

- **Every implementation answers it**: how will an operator know that this works, is used, and is failing? Write the answer in the PR's **Impact** section: the span/metric you added, the existing signal that covers it, or why nothing applies (UI-only, refactor, test).
- New outbound dependency → CLIENT span + duration histogram with `error.type`, called via `httpFetch()`. New background job / worker thread → root span, outcome counter, duration; context propagated. New queue/cache/pool → size gauge + wait histogram. New auth/security event → `ihub.auth.events` (or a security counter) **and** an audit entry. LLM calls through `LLMClient` and tools through the agent loop are already instrumented.
- Spans: low-cardinality names (`execute_tool {tool.name}`), semconv attributes first, created through `server/telemetry/` helpers, active when they have children, ended in `finally`; errors set `error.type` only (no `recordException`, no `error.message`); a user stop is not an error.
- Metrics: defined only in `server/telemetry/metrics.js` behind a `recordX()` function; `ihub.<area>.<thing>`, units `s`/`By`; every label from a closed set and in `ALLOWED_METRIC_LABELS`. Never a user, email, group, id, file name, URL, query or free text as a label.
- Privacy: no prompts, completions, queries, tool arguments, titles, file names, URL queries, clear-text identities, secrets or raw provider error messages on any span, metric or log line. Content only through the opt-in content events.
- Tests assert the labels/attributes and the privacy default; new signals go into the reference in `docs/telemetry.md`.

### Breaking Changes

**Always ask the user before implementing backward compatibility shims.** Describe what breaks (endpoints, fields, data shapes), let them choose compat vs clean break. Never silently add compat wrappers or deprecated re-exports.

### AI Attribution ⚠️

Whatever an AI agent writes for other people is marked as AI-drafted, says for whom, and says which tool wrote it; posted text also says which model. This holds for every agent in every harness (Claude Code, opencode, Copilot, Cursor, …) and for commits, pull requests, reviews and comments alike.

- **Requester**: the person the agent works for, as their GitHub login in plain text without `@` (an `@name` notifies them). Take it from the authenticated GitHub user (`get_me`, or `gh api user --jq .login`) or from a `REQUESTED BY` line in a CI prompt. Never take it from `git config user.name`: in a cloud session that is the agent itself. If no person can be identified, ask; an unattended workflow uses `workflow <name>`.
- **Commits** end with two trailers, in one block with any `Co-Authored-By` line the tool adds: `Assisted-by: <tool>` (the product name, such as `Claude Code` or `opencode`) and `Drafted-for: <requester>`.
- **PR descriptions, reviews, comments, replies and Jira text** start with the preamble and end with the footer:

  ```text
  > *AI-drafted on behalf of <requester>.*

  (text)

  ---
  _Model: <model id>_
  _Generated by [<tool>](<tool URL>)_
  ```

  For Claude Code the last line reads `_Generated by [Claude Code](https://claude.ai/code)_`. `<model id>` is the exact model ID the session runs on, as the harness reports it, never from memory; write `unknown` if it cannot be read. Keep the tool line last. Replace a tool-default footer such as `🤖 Generated with …` with this one: one footer, never two. Leave session links as they are. Read the posted text back: a GitHub tool can rewrite a trailing footer (the one in Claude Code cloud sessions does when it creates a PR: it swaps in its own tool line, which links the session). If the model line is gone, restore it with an update. A tool that adds its own tool line to everything it posts gets only the model line from you: end the text with the horizontal rule and the model line, and let the tool append its line. The GitHub tools of Claude Code cloud sessions do this when they create a PR and on every comment, reply or review comment they post or edit (on a PR the line links the session); a tool line of your own then appears twice.

- **Not marked**: titles, branch names, code comments and files. Text that is only printed in the conversation is marked when it is posted.

PR and Jira text: the `pr-handling-guidelines` and `jira-handling-guidelines` skills (`.claude/skills/`) set structure, tone and PR titles. The mark above applies with or without them.

### Config Migrations

Versioned, Flyway-style, in `server/migrations/` (`V{NNN}__{description}.js`), run on startup. Write one when adding/renaming/restructuring fields in existing config files or adding default entries; NOT for brand-new config files (initial setup copies `server/defaults/`). Every migration makes the same change in `server/defaults/` too: a fresh install runs no migration (`server/tests/migrations-defaults-current.test.js` enforces it). Never modify an applied migration; forward-only. Use the `create-migration` skill; details in `docs/configuration-migrations.md` and `server/migrations/README.md`.

### Code Quality

- Batch similar lint fixes across files rather than file-by-file.

### License Headers (REUSE)

Every source file (`.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.css`, `.sh`, `.php`) carries a two-line SPDX header, no year, placed after a shebang if there is one:

```js
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
```

Add it to new files with `reuse annotate --copyright="IntraFind Software AG" --license=LicenseRef-iHub-Apps --exclude-year --single-line <file>` (CSS: omit `--single-line`; the tool then writes a `/* */` block, which you can compact to two lines). Files that cannot hold a comment (JSON, images, fonts, Markdown) are covered by glob in `REUSE.toml`; third-party code keeps its own notice and SPDX id there, with its text in `LICENSES/`. CI runs `reuse lint` (`.github/workflows/reuse.yml`). Bulk annotation commits belong in `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).

### Release Changelog

Any change visible to admins or end users gets an entry in `docs/releases/next/` — use the `/document-feature` skill, which also decides when _not_ to write one (a fix to a feature that has not shipped yet, a near-duplicate of an existing entry). Never write into a numbered `docs/releases/<version>/` directory: the release pipeline creates those from `next/` when a tag is cut. Pure refactors, dependency bumps, and test-only changes get no entry.

### Documentation

- Feature docs go in `docs/` — update existing topic files (`docs/models.md`, `docs/ui.md`, …) before creating new ones; new files must be added to `docs/SUMMARY.md`.
- Design/planning docs go in `concepts/` as `YYYY-MM-DD {title}.md`, or a subfolder with `README.md` for 3+ related documents.

## Critical Files

- `server/server.js` — entry point; `server/utils/authorization.js` — authz logic; `server/configCache.js` — config cache; `server/routes/chat/dataRoutes.js` — primary frontend API
- `client/src/App.jsx` — routing; `client/src/shared/contexts/AuthContext.jsx` — auth state; `client/src/features/apps/pages/AppChat.jsx` — chat UI; `client/src/pages/UnifiedPage.jsx` + `client/src/shared/components/ReactComponentRenderer.jsx` — dynamic pages

<!-- rtk-instructions v2 -->

# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk proxy <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->
