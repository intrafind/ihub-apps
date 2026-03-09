# iHub Apps — Usability Simplification Plan

## Context

iHub Apps is a full-stack AI application platform with genuine enterprise value (30+ micro-apps, multi-provider LLM support, enterprise auth, admin UI). Despite strong functionality, it has only 17 GitHub stars — signaling a **developer experience gap**, not a product gap. The distance between "I found this project" and "I'm getting value from it" is too large.

**Critical insight from codebase exploration:** The admin UI **already supports** runtime API key management per-provider and per-model with AES-256-GCM encryption at rest. The server starts without `.env`. Everything can be configured from the browser. This is a massive strength that's completely invisible — the README, quickstart, and .env.example all steer users toward manual `.env` editing as if it's required.

**The core problem is not missing features — it's that existing capabilities are hidden behind outdated documentation and missing "last mile" UX.**

This plan is a concept document / roadmap for the team to review and prioritize. No code changes in this session.

---

## Phase 1 — Reframe the Narrative (1-2 days, text-only changes)

### 1.1 Rewrite `.env.example` to say ".env is optional"

**Current state:** `.env.example` lists 7+ API keys with legacy per-model entries (`GPT_3_5_TURBO_API_KEY`, `CLAUDE_3_OPUS_API_KEY`). New users think they must fill this out.

**Truth:** The server starts with no `.env` at all. API keys can be added via admin UI at `/admin/providers`. The `.env.example` should reflect this.

**Proposed `.env.example`:**
```bash
# ============================================================
# iHub Apps — Environment Variables (OPTIONAL)
# ============================================================
# You do NOT need this file to get started!
#
# Just run: npm run dev
# Then open http://localhost:3000 and configure API keys
# through the admin UI at /admin/providers.
#
# This file is only needed for:
#   - CI/CD pipelines or Docker deployments where you want
#     to inject keys via environment variables
#   - Overriding settings that aren't in the admin UI
# ============================================================

# --- API Keys (alternative to admin UI) ---
#OPENAI_API_KEY=
#ANTHROPIC_API_KEY=
#GOOGLE_API_KEY=
#MISTRAL_API_KEY=

# --- Server (rarely needed) ---
#PORT=3000
#WORKERS=1

# --- Proxy (if behind corporate proxy) ---
#HTTP_PROXY=http://proxy.example.com:8080
#HTTPS_PROXY=http://proxy.example.com:8080
```

**Files:** `.env.example`
**Impact:** High — eliminates the biggest confusion point
**Effort:** 30 minutes

---

### 1.2 Update README quickstart to remove `.env` editing

**Current quickstart:**
```bash
git clone <repository-url>
cd ihub-apps
npm run setup:dev
# Edit .env with your API keys   ← THIS STEP SHOULDN'T EXIST
npm run dev
```

**Proposed quickstart:**
```bash
git clone https://github.com/intrafind/ihub-apps.git
cd ihub-apps
npm run setup:dev
npm run dev
# Open http://localhost:3000 → Add your API key in Settings
```

Also update the Docker quickstart to not require `-e OPENAI_API_KEY`:
```bash
docker run -d -p 3000:3000 -v $(pwd)/contents:/app/contents \
  --name ihub-apps ghcr.io/intrafind/ihub-apps:latest
# Open http://localhost:3000 → Configure API keys in admin UI
```

**Additionally:**
- Sharpen the tagline: *"30+ ready-to-use AI apps for your team. Self-hosted. No prompting expertise needed."*
- Lead with a screenshot/GIF showing the app in action
- Add a "What's included" visual grid showing the built-in apps with icons
- Move detailed config reference from README to `/docs`

**Files:** `README.md`
**Impact:** High — first impression transformation
**Effort:** 2-4 hours

---

### 1.3 Update `npm run setup:dev` to not require `.env`

**Current behavior:** `setup:dev` copies `.env.example` → `.env`, then tells the user to edit it.

**Proposed:** Skip the `.env` copy (or make it optional). Print a message:
```
✓ Dependencies installed
✓ Default configuration created

Ready! Run: npm run dev
Then open http://localhost:3000 to configure your AI providers.
```

**Files:** `package.json` (setup:dev script), possibly `scripts/setup-dev.sh` or similar
**Impact:** Medium — removes a confusing step
**Effort:** 30 minutes

---

## Phase 2 — First-Run Experience (3-5 days)

### 2.1 First-run welcome / setup wizard in browser

**Problem:** When a user starts iHub Apps for the first time with no API keys, they see an app grid where every app will fail. There's no guidance.

**Solution:** Detect "unconfigured state" (no LLM provider has an API key) and show a lightweight welcome overlay or redirect to a setup page:

- **Step 1:** "Welcome to iHub Apps" — 1-sentence value prop, screenshot
- **Step 2:** "Connect your first AI provider" — pick provider (Google free tier highlighted), paste key, "Test Connection" button
- **Step 3:** "You're all set!" — redirect to the chat app

**Key design decisions:**
- **Reuse existing infrastructure** — the admin providers page (`/admin/providers`) already has API key input, encryption, and test functionality. The wizard should wrap this existing logic in a friendlier UI, not duplicate it.
- **Detection:** New endpoint `GET /api/setup/status` → returns `{ configured: boolean }` based on whether any LLM provider has an API key (check via `ApiKeyVerifier.validateEnabledModelsApiKeys()`)
- **Show only once** — once any key is configured, never show again
- **Skippable** — "Skip, I'll configure later" option

**Files:**
- New: `client/src/features/setup/SetupWizard.jsx`
- New: `server/routes/setup.js` (thin wrapper around existing provider/model logic)
- Modify: `client/src/App.jsx` (add route)
- Modify: `client/src/utils/runtimeBasePath.js` (add `/setup` to knownRoutes)
- Reuse: `server/routes/admin/providers.js` (existing API key save + test endpoints)
- Reuse: `server/utils/ApiKeyVerifier.js` (`validateEnabledModelsApiKeys()`)
- Reuse: `server/services/TokenStorageService.js` (encryption)

**Impact:** Very high — transforms first impression from "broken" to "guided"
**Effort:** 3-4 days

---

### 2.2 Provider health dashboard on the providers page

**Problem:** The admin providers page (`/admin/providers`) shows providers and API key status, but has no connectivity health overview. Admins can only test models one-by-one from the separate models page.

**Existing capabilities:**
- Individual model testing exists: `POST /api/admin/models/{modelId}/test` (in `server/routes/admin/models.js`)
- Provider list with `apiKeySet` status exists: `GET /api/admin/providers`
- `ApiKeyVerifier.validateEnabledModelsApiKeys()` returns comprehensive status

**Solution:** Enhance the existing providers admin page with health status:
- For each provider, show: name, API key status (configured/unconfigured), # enabled models, connectivity status
- "Test All" button that runs the existing model test endpoint for each enabled model of that provider
- Green/yellow/red status: all models working / some working / none working
- Expandable section per provider showing individual model test results

**Files:**
- Modify: `client/src/features/admin/pages/AdminProvidersPage.jsx` (or equivalent provider admin component)
- Optionally new: `server/routes/admin/providerStatus.js` (bulk status endpoint)
- Reuse: `server/routes/admin/models.js` (existing test endpoint)
- Reuse: `server/utils/ApiKeyVerifier.js`

**Impact:** Medium — admin efficiency, natural place for health info
**Effort:** 2-3 days

---

## Phase 3 — Distribution & Discoverability (1-2 weeks each)

### 3.1 `npx ihub` — zero-install trial

**Current state:** `bin` entry exists in `package.json` (`"ihub-apps": "./server/sea-server.cjs"`), binary builds work, GitHub Releases publish cross-platform artifacts. The infrastructure is 80% there.

**What's needed:**
1. Rename bin entry from `ihub-apps` to `ihub` (shorter, cleaner)
2. Pre-build client and include `client/dist/` in npm package
3. Add `"files"` field to `package.json` to control what gets published
4. Ensure `sea-server.cjs` runs `performInitialSetup()` on startup (it may already via server.js)
5. Add `"publishConfig"` to `package.json`
6. Set up npm publish in CI/CD pipeline
7. `npx ihub` → starts server → opens browser → shows setup wizard

**Additionally consider `npx create-ihub-app`:** Following the `create-*` pattern (Next.js, Vite, Svelte), a scaffolding command could create a customized instance:
```bash
npx create-ihub-app my-ai-hub
# → Interactive wizard: pick provider, paste key, choose apps
# → Scaffolds a directory with config + starts server
```
This is a separate npm package (`create-ihub-app`) that scaffolds a project using iHub Apps as a dependency. Lower priority than `npx ihub` but a natural evolution.

**Files:** `package.json`, `server/sea-server.cjs`, `.github/workflows/`
**Impact:** Very high — the gold standard for discoverability
**Effort:** 1-2 weeks (mostly CI/CD and testing)

---

### 3.2 Docker Hub publish + zero-config compose

**Current state:** Images on GHCR (`ghcr.io/intrafind/ihub-apps:latest`), production docker-compose requires `.env.production`.

**Proposed:**
- Also publish to Docker Hub for discoverability
- Ship a `docker-compose.quickstart.yml` that works with zero edits:
  ```yaml
  services:
    ihub-apps:
      image: ghcr.io/intrafind/ihub-apps:latest
      ports: ["3000:3000"]
      volumes: ["./contents:/app/contents"]
  ```
  No env vars needed — configure everything via browser after startup.

**Files:** `docker-compose.quickstart.yml` (new), `.github/workflows/`, `docker/DOCKER.md`
**Impact:** Medium-high
**Effort:** 3-5 days

---

### 3.3 Curl installer + Homebrew tap

**Current state:** Binary builds already published to GitHub Releases for Linux/macOS/Windows (12 platform-specific assets per release). Base64-encoded variants exist for firewall-restricted environments. The binary infrastructure is ready — it just needs the distribution layer.

**Curl installer (`install.sh`) — flagship installation method:**
- Hosted at a memorable URL: `https://ihub.app/install` (or fallback: `https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh`)
- Following Coolify's pattern (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`) and Railway's short URL (`curl -fsSL cli.new | sh`)
- Detects OS (Linux/macOS/Windows) and architecture (x64/arm64)
- Checks for Docker — if available, offers to pull the Docker image instead of installing binary
- Downloads correct binary from GitHub Releases
- Verifies checksums after download
- Installs to `~/.local/bin` (user-local, no sudo required) or `/usr/local/bin`
- Generates a secure JWT secret automatically
- Wraps all logic in `main()` function to prevent partial execution on network interruption
- Uses HTTPS exclusively
- Optionally starts the application after install (`--start` flag)
- Usage: `curl -fsSL https://ihub.app/install | sh`

**Homebrew tap:**
- Create `intrafind/homebrew-ihub` repo with a formula
- `brew tap intrafind/ihub && brew install ihub`
- GitHub Actions workflow auto-updates the formula on each release (GoReleaser pattern)
- Formula downloads pre-built binary from GitHub Releases

Both methods install the `ihub` binary, which then works with the CLI subcommands (see 3.4).

**Files:** New `install.sh`, new `homebrew-ihub` repo, `.github/workflows/`
**Impact:** High — meets developers on platforms they already use (macOS: brew, Linux: curl)
**Effort:** 1 week

---

### 3.4 `ihub` CLI with noun-verb subcommands

**Current CLI:** Binary launcher only (starts the server). No `--help`, `--version`, or subcommands. All interaction goes through `npm run *` scripts, which is standard for Node.js but lacks the polish of tools like Railway CLI, Coolify, or Supabase CLI.

**Design principle:** Follow the **noun-verb pattern** — top-level nouns for resources, verbs for actions. Every command should have both interactive mode (prompts) and flag-based mode (scriptable for CI).

**Proposed command tree:**

```
# ─── Core lifecycle ───
ihub start              # Start the server (replaces npm run dev / npm start)
ihub stop               # Stop a running instance
ihub setup              # Interactive first-run wizard (terminal-based)
ihub open               # Open browser to running instance
ihub status             # Show running instance: version, uptime, configured providers, active models, active users
ihub update             # Self-update to latest version (binary: download new, npm: suggest npm update)
ihub doctor             # Diagnose issues: ports, API keys, connectivity, config syntax, disk space, Node version

# ─── App management ───
ihub apps list          # Show configured apps (name, model, enabled status)
ihub apps add           # Interactive app creation wizard (or --name "Bot" --model gpt-4o --system "...")
ihub apps enable <id>   # Enable a disabled app
ihub apps disable <id>  # Disable an app

# ─── Model management ───
ihub models list        # Show configured models (name, provider, API key status)
ihub models add         # Interactive model addition (or --provider openai --model gpt-4o)
ihub models test <id>   # Test a specific model's connectivity

# ─── Configuration ───
ihub config show        # Print current resolved config (merged defaults + overrides)
ihub config edit        # Open config in $EDITOR
ihub config reset       # Reset to defaults (with confirmation)

# ─── Data management ───
ihub logs               # Stream server logs with filtering (--level error, --since 1h)
ihub backup             # Archive contents/ directory with timestamp
ihub restore <file>     # Restore from a backup archive
```

**Implementation details:**
- Use `@clack/prompts` for interactive terminal UI (used by Astro, SvelteKit) — beautiful spinners, select menus, confirmations
- Every interactive command also accepts flags for scriptable usage: `ihub apps add --name "My Bot" --model gpt-4o --system "You are helpful"`
- Shell completions generated via `ihub completions bash|zsh|fish|powershell`
- Rich `--help` on every command with examples
- `ihub apps add` in interactive mode: asks name → picks model from configured list → asks for system prompt → creates JSON in `contents/apps/` → confirms with "App created! Open it at http://localhost:3000/apps/my-bot"
- `ihub models add` in interactive mode: picks provider → asks for model ID → checks API key → runs test → creates JSON in `contents/models/`
- `ihub doctor` output follows pass/fail pattern:
  ```
  ✓ Node.js v24.1.0
  ✓ Port 3000 available
  ✓ OpenAI API key configured
  ✗ Anthropic API key missing — set via admin UI at /admin/providers or ANTHROPIC_API_KEY env var
  ✓ Google API key configured
  ✓ 3 models responding
  ✗ 2 models unreachable — run "ihub models test" for details
  ✓ Config files valid
  ✓ 847 MB disk space available
  ```

**Files:** New `cli/` directory with command modules, or extend `server/sea-server.cjs` with commander/yargs
**Impact:** High — transforms the product from "Node.js project" to "proper developer tool"
**Effort:** 2-3 weeks

---

## Phase 4 — Reduce Config Surface Area (1 week)

### 4.1 Convention over configuration for platform.json

**Problem:** `server/defaults/config/platform.json` is 144 lines. Most fields (rate limiting, CORS, PDF export, logging, JWT algorithm) have sane defaults that 95% of users never change.

**Proposed:** Move defaults into code. Ship a minimal `platform.json`:
```json
{
  "defaultLanguage": "en",
  "auth": { "mode": "local" },
  "anonymousAuth": { "enabled": true, "defaultGroups": ["anonymous"] },
  "localAuth": { "enabled": true }
}
```

`configCache.js` applies programmatic defaults via `mergeDefaults()` for everything else. Power users can still override any field.

**Files:** `server/configCache.js`, `server/defaults/config/platform.json`
**Impact:** Medium — less intimidating config
**Effort:** 3-5 days (careful backward-compat testing)

---

### 4.2 Comprehensive IHUB_* environment variable overrides

**Current state:** Only ~20 env vars are supported (provider keys, port, proxy, SSL). No systematic mapping.

**Proposed:** Every JSON config value should have a corresponding `IHUB_*` env var:
- `IHUB_AUTH_MODE=anonymous` → `platform.json` `auth.mode`
- `IHUB_DEFAULT_LANGUAGE=de` → `platform.json` `defaultLanguage`
- `IHUB_THEME=dark` → `ui.json` theme

Critical for Docker/Kubernetes deployments where env vars are the native config mechanism.

**Files:** `server/configCache.js`, documentation
**Impact:** Medium — unlocks container orchestration
**Effort:** 3-5 days

---

## Phase 5 — README as Conversion Funnel (1-2 days)

### 5.1 Restructure README

Current README is 1,434 lines — comprehensive but reads like reference docs, not a landing page.

**Proposed structure:**
1. **Hero** (5 lines): Tagline + badges + fastest install command
2. **Screenshot/GIF** (1 visual): App in action — user chatting with AI
3. **Quick Start** (10 lines max): 3 steps to running
4. **What's Included** (visual grid): Icons + names of the 19+ built-in apps
5. **Deploy Anywhere** (tabs): Docker | Binary | npm | Electron
6. **Extend** (links): Creating apps, adding models, auth setup → link to `/docs`
7. **Contributing** (brief)

Move everything else to `/docs`. README should be a landing page, not a manual.

**Files:** `README.md`
**Impact:** High — first impression for every GitHub visitor
**Effort:** 1-2 days

---

## Prioritized Implementation Order

| # | Item | Impact | Effort | Dependency |
|---|------|--------|--------|------------|
| 1 | 1.1 Rewrite `.env.example` | High | 30 min | None |
| 2 | 1.2 Update README quickstart | High | 2-4 hrs | None |
| 3 | 1.3 Fix `setup:dev` flow | Medium | 30 min | None |
| 4 | 2.1 First-run setup wizard | Very High | 3-4 days | None |
| 5 | 2.2 Provider health dashboard | Medium | 2-3 days | None |
| 6 | 5.1 README conversion funnel | High | 1-2 days | None |
| 7 | 3.2 Docker zero-config compose | Med-High | 3-5 days | CI/CD |
| 8 | 3.3 Curl installer + Homebrew | High | 1 week | Binary builds |
| 9 | 3.1 `npx ihub` | Very High | 1-2 weeks | npm pipeline |
| 10 | 3.4 `ihub` CLI subcommands | High | 2-3 weeks | None |
| 11 | 4.1 Slim down platform.json | Medium | 3-5 days | None |
| 12 | 4.2 IHUB_* env var mapping | Medium | 3-5 days | None |

**Quick win sprint (items 1-3):** Could be done in a single day and would immediately improve the onboarding story.

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Steps to first chat | 5+ (clone, install, edit .env, run dev, pick app) | 3 (clone, install+run, add key in browser) |
| Time to first chat | ~15 min | <3 min |
| "API key not found" errors on first use | Very common (19 apps, maybe 1 provider configured) | Near zero (setup wizard guides users to configure a provider first) |
| Lines in README before quickstart | ~10 (paragraph + vision) | 3 (tagline + screenshot) |

## Non-Goals

- Changing core architecture (Express, React, Vite, file-based config)
- Reducing total features — goal is progressive disclosure, not removal
- Changing Node.js version requirement (staying at 24+)
- Changing which apps ship enabled by default (all remain enabled)
- Adding backward compatibility shims (clean changes only)
