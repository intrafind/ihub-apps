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
- Reload behavior: platform/auth changes need a server restart; apps, models, UI, groups, sources, tools reload automatically via `configCache`.
- React pages (`contents/pages/{lang}/{id}.jsx`): component must be named `UserComponent`, receives hooks/`t`/`navigate`/`user` via props, no import/export. Details: `docs/react-component-feature.md`.
- Local LLM providers (LM Studio, Jan.ai, vLLM): OpenAI-compatible, `provider: "openai"`. See `docs/local-llm-providers.md`.

### Secret Encryption at Rest

Platform config secrets (Jira, OIDC, LDAP, NTLM, Cloud Storage) are AES-256-GCM encrypted in `platform.json`; key at `contents/.encryption-key`. Encrypt on admin save, decrypt + redact on admin read, decrypt into cache at runtime. Plaintext passes through and is lazily encrypted on next save. Key files: `server/services/TokenStorageService.js`, `server/routes/admin/configs.js`, `server/configCache.js`.

## Development Rules

### When Adding New Routes ⚠️

New top-level routes in `client/src/App.jsx` MUST also be added in **both**:

1. `KNOWN_ROUTES` in `client/src/utils/runtimeBasePath.js`
2. The inline `knownRoutes` array in `client/index.html`

The lists must stay identical (`tests/unit/client/known-routes-sync.test.jsx` enforces it). Miss the `index.html` copy and a **cold load** of the route treats the route segment as the base path — the auth gate hits `/<route>/api/auth/status`, 404s, and shows "Unable to connect to the server". Test both root (`/reports`) and subpath (`/ihub/reports`) deployments with direct URL loads.

### Breaking Changes

**Always ask the user before implementing backward compatibility shims.** Describe what breaks (endpoints, fields, data shapes), let them choose compat vs clean break. Never silently add compat wrappers or deprecated re-exports.

### Config Migrations

Versioned, Flyway-style, in `server/migrations/` (`V{NNN}__{description}.js`), run on startup. Write one when adding/renaming/restructuring fields in existing config files or adding default entries; NOT for brand-new config files (initial setup copies `server/defaults/`). Never modify an applied migration; forward-only. Use the `create-migration` skill; details in `docs/configuration-migrations.md` and `server/migrations/README.md`.

### Code Quality

- Batch similar lint fixes across files rather than file-by-file.

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
