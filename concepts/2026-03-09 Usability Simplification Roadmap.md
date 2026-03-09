# iHub Apps — Usability Simplification Roadmap

**Date:** 2026-03-09
**Status:** Proposal
**Goal:** Reduce friction across installation, configuration, first-run experience, and ongoing usage so more people can try and adopt iHub Apps.

---

## Problem Statement

iHub Apps is a powerful AI applications platform, but its current setup has significant friction that prevents casual adoption. A new user today must:

1. Have Node.js 24+ installed
2. Clone the repository
3. Run `npm run setup:dev` and `npm run dev`
4. Manually configure API keys in a `.env` file
5. Understand a complex configuration system (19 apps, 17 models, 10+ config files)

...before they can use even a basic chat. There is no guided first-run experience, no single-command installation, and no way to try the product without cloning the repo.

---

## Tier 1: Quick Wins

### 1.1 Simplify `.env.example` — Only One Key Needed

**Problem:** The `.env.example` lists 7+ API keys with legacy per-model entries (`GPT_3_5_TURBO_API_KEY`, `CLAUDE_3_OPUS_API_KEY`, etc.). This is overwhelming for new users who don't know which keys they need.

**Solution:** Restructure `.env.example` with a clear "Quick Start" section at the top:

```bash
# === QUICK START ===
# You only need ONE API key to get started.
# Gemini has a free tier — get a key at https://aistudio.google.com/apikey
GOOGLE_API_KEY=

# === OPTIONAL: Additional providers ===
# Uncomment and set these to enable more models
#OPENAI_API_KEY=
#ANTHROPIC_API_KEY=
#MISTRAL_API_KEY=
```

Remove the confusing per-model API key entries. Provider-level keys (`OPENAI_API_KEY`) already work for all models from that provider.

**Impact:** High — eliminates the #1 "where do I even start?" confusion
**Effort:** Low (text editing only)
**Files:** `.env.example`

---

### 1.2 Show App Readiness Status in the UI

**Problem:** All 19 apps are visible when the platform starts, but most will fail with "API key not found" when clicked because the required model's provider isn't configured. This is a terrible first impression.

**Solution:** Add a readiness indicator to app cards:
- Apps whose required model has a configured API key → shown normally
- Apps whose model is unconfigured → shown with a subtle "Setup required" badge and tooltip explaining which API key is needed
- Clicking an unconfigured app could show a helpful message instead of a cryptic error

**Implementation approach:**
- Extend `GET /api/apps` response to include `ready: boolean` and `requiredProvider: string` per app
- In `server/routes/chat/dataRoutes.js`, check API key availability using `ApiKeyVerifier.getApiKeyForModel()`
- In the client app grid, render a visual distinction for unready apps

**Impact:** High — users immediately understand what works and what needs setup
**Effort:** Medium
**Files:** `server/routes/chat/dataRoutes.js`, `server/utils/ApiKeyVerifier.js`, `client/src/features/apps/` components

---

### 1.3 `ihub-apps init` — Guided CLI Setup

**Problem:** Setting up `.env` manually is error-prone and undiscoverable. Users don't know which keys are needed or where to get them.

**Solution:** Add an interactive CLI init command:

```bash
npm run init
# or: node scripts/init.js
```

The command would:
1. Ask: "Which AI provider do you want to use?" → list Google (free tier!), OpenAI, Anthropic, Mistral
2. Print the sign-up URL for the chosen provider
3. Ask: "Paste your API key:"
4. Write to `.env` file
5. Print: "Done! Run `npm run dev` to start."

**Impact:** Medium — makes first-time setup guided and foolproof
**Effort:** Low-Medium
**Files:** New `scripts/init.js`, update `package.json` scripts

---

### 1.4 Admin System Health Dashboard

**Problem:** The admin panel has no overview of which providers are configured, which models are working, and what's broken. Admins diagnose issues by reading server logs.

**Solution:** Add a "Provider Status" section to the admin system page:
- Each provider (Google, OpenAI, Anthropic, Mistral) with green/red dot
- Number of enabled models per provider
- "Test Connection" button that sends a minimal request and reports success/error
- Optionally: model-level health (which specific models respond correctly)

**Impact:** Medium — saves admin debugging time, gives confidence the system is working
**Effort:** Medium
**Files:** `client/src/features/admin/pages/AdminSystemPage.jsx`, new `server/routes/admin/providerStatus.js`

---

### 1.5 First-Run Setup Wizard in the Browser

**Problem:** Non-technical users (or users deploying via Docker) can't easily edit `.env` files. The product should guide them through setup in the browser.

**Solution:** When the server starts with no API keys configured, show a setup wizard instead of the normal app:

- **Step 1:** "Welcome to iHub Apps" — brief intro with 1-sentence value prop
- **Step 2:** "Add your first AI provider" — pick provider, paste key, test connection inline
- **Step 3:** "You're ready!" — redirect to the main app

Detection: check if *any* LLM API key is present. If none, redirect to `/setup`.

Store the key in encrypted `contents/config/providers.json` (using existing `TokenStorageService`) so it persists without needing `.env`.

**Impact:** High — enables zero-config Docker deployments and browser-only setup
**Effort:** Medium-High
**Files:** New `client/src/features/setup/SetupWizard.jsx`, new `server/routes/setup.js`, `client/src/App.jsx`, `client/src/utils/runtimeBasePath.js`

---

## Tier 2: Strategic Improvements

### 2.1 `npx ihub-apps` — Zero-Install Experience

**Problem:** There's no way to try iHub Apps without cloning the repo. Tools like `npx create-react-app` or `npx serve` let developers try things in seconds.

**Solution:** Make `npx ihub-apps` work:

1. Pre-build the client and include `client/dist/` in the npm package
2. Ensure `server/sea-server.cjs` (or a new entry point) handles first-run setup (copies default configs)
3. Add proper `"files"` field to `package.json` to control package contents
4. Publish to npm as `ihub-apps`

User experience:
```bash
npx ihub-apps
# → Downloads package, copies defaults, opens browser at localhost:3000
# → Setup wizard appears, user pastes API key, starts chatting
```

**Impact:** High — the best possible first-impression experience
**Effort:** High (npm publish pipeline, pre-built assets, startup logic)
**Files:** `package.json`, `server/sea-server.cjs`, CI/CD pipeline

---

### 2.2 Docker One-Liner with API Key Passthrough

**Problem:** Docker usage currently requires cloning the repo and creating `.env` files.

**Solution:** Publish images to Docker Hub / GitHub Container Registry and support:

```bash
docker run -p 3000:3000 -e GOOGLE_API_KEY=your-key intrafind/ihub-apps
```

The image should work standalone without volume mounts for basic usage. Power users can mount `contents/` for customization.

**Impact:** Medium-High — the easiest path for non-developers
**Effort:** Medium (CI/CD for image publishing, testing)
**Files:** `docker/Dockerfile`, CI/CD pipeline

---

### 2.3 Homebrew Formula and Install Script

**Problem:** macOS developers expect `brew install`. Linux users expect `curl | sh`.

**Solution:**
- Create a Homebrew tap: `brew tap intrafind/ihub-apps && brew install ihub-apps`
- Create `install.sh` that detects OS/arch and downloads the correct binary from GitHub Releases:
  ```bash
  curl -fsSL https://ihub-apps.dev/install.sh | sh
  ```

**Impact:** Medium — familiar install paths for different audiences
**Effort:** Medium
**Files:** New `homebrew-tap` repo, `install.sh` script, GitHub Release automation

---

### 2.4 Runtime API Key Management (No `.env` Editing)

**Problem:** Adding or changing API keys requires editing `.env` and restarting the server. This is unfriendly for deployed instances.

**Solution:** Let admins manage API keys through the admin UI at runtime:

- Extend the admin UI to support adding/editing API keys per provider
- Store keys in encrypted `contents/config/providers.json` using existing `TokenStorageService`
- Modify `getApiKeyForModel()` in `server/utils.js` to check `providers.json` first, fall back to env vars
- No server restart needed — uses hot-reloaded `configCache`

**Impact:** High — eliminates the most common maintenance friction
**Effort:** Medium-High
**Files:** `server/utils.js`, `server/configCache.js`, `client/src/features/admin/` pages

---

### 2.5 Reduce Default Configuration Surface Area

**Problem:** `platform.json` (144 lines), `ui.json` (323 lines) expose every possible setting by default. This makes the config files intimidating and easy to misconfigure.

**Solution:** Apply "convention over configuration":
- Move safe defaults into code (rate limiting, CORS, PDF export, logging defaults)
- Ship a minimal `platform.json` (~20 lines) with only commonly-changed settings:
  ```json
  {
    "defaultLanguage": "en",
    "auth": { "mode": "local" },
    "anonymousAuth": { "enabled": true }
  }
  ```
- `configCache.js` applies programmatic defaults via `mergeDefaults()` for everything else
- Full config remains accessible for power users who want to override

**Impact:** Medium — less intimidating config, fewer things to get wrong
**Effort:** Medium (careful backward-compatibility testing needed)
**Files:** `server/configCache.js`, `server/defaults/config/platform.json`, `server/defaults/config/ui.json`

---

## Recommended Implementation Order

| # | Improvement | Impact | Effort | Dependency |
|---|-----------|--------|--------|------------|
| 1 | 1.1 Simplify `.env.example` | High | Low | None |
| 2 | 1.3 `ihub-apps init` CLI | Medium | Low-Med | None |
| 3 | 1.2 App readiness status | High | Medium | None |
| 4 | 1.4 Admin health dashboard | Medium | Medium | None |
| 5 | 2.4 Runtime API key mgmt | High | Med-High | None |
| 6 | 1.5 Browser setup wizard | High | Med-High | 2.4 (stores keys) |
| 7 | 2.5 Reduce config surface | Medium | Medium | None |
| 8 | 2.2 Docker one-liner | Med-High | Medium | CI/CD |
| 9 | 2.1 `npx ihub-apps` | High | High | npm pipeline |
| 10 | 2.3 Homebrew + curl install | Medium | Medium | Binary builds |

---

## Success Metrics

- **Time to first chat:** Currently ~15 min (clone, install, configure). Target: <2 min (npx/Docker + setup wizard).
- **Setup abandonment:** Measure how many users start `npm run dev` but never send a chat message.
- **Configuration errors:** Track "API key not found" errors — should drop to near zero with readiness indicators.
- **Admin efficiency:** Time to diagnose "why isn't model X working?" — should be instant with health dashboard.

---

## Non-Goals

- Changing the core architecture (Express, React, Vite)
- Reducing the total number of features — the goal is to make them progressively discoverable, not remove them
- Changing the Node.js version requirement (staying at 24+)
- Changing which apps ship by default (all 19 remain enabled)
