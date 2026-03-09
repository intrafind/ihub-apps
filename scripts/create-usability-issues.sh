#!/usr/bin/env bash
# Create GitHub issues for iHub Apps usability simplification roadmap
# Run this locally where `gh` is authenticated: gh auth login
# Usage: bash scripts/create-usability-issues.sh

set -euo pipefail

REPO="intrafind/ihub-apps"

# Ensure labels exist
echo "Creating labels..."
gh label create "dx" --description "Developer Experience" --color "7057ff" --repo "$REPO" 2>/dev/null || true
gh label create "documentation" --description "Documentation improvements" --color "0075ca" --repo "$REPO" 2>/dev/null || true
gh label create "quick-win" --description "Low effort, high impact" --color "2ea44f" --repo "$REPO" 2>/dev/null || true
gh label create "distribution" --description "Installation and distribution" --color "e4e669" --repo "$REPO" 2>/dev/null || true
gh label create "admin-ui" --description "Admin interface improvements" --color "d876e3" --repo "$REPO" 2>/dev/null || true
gh label create "cli" --description "CLI tooling" --color "006b75" --repo "$REPO" 2>/dev/null || true
gh label create "configuration" --description "Configuration system" --color "fbca04" --repo "$REPO" 2>/dev/null || true

echo ""
echo "Creating issues..."

# --- Issue 1 ---
gh issue create --repo "$REPO" \
  --title "Rewrite .env.example to clarify that .env is optional" \
  --label "dx,quick-win,documentation" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

The current `.env.example` lists 7+ API keys with legacy per-model entries (`GPT_3_5_TURBO_API_KEY`, `CLAUDE_3_OPUS_API_KEY`). New users believe they must fill this out before starting.

**The truth:** The server starts with no `.env` at all. API keys can be added entirely via the admin UI at `/admin/providers` with AES-256-GCM encryption at rest.

## Proposed Change

Rewrite `.env.example` to make it clear that it's optional:

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

Remove legacy per-model API key entries that are confusing and redundant with provider-level keys.

## Files
- `.env.example`

## Impact
High — eliminates the #1 confusion point for new users.

## Effort
~30 minutes

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 1.1
ISSUE_EOF
)"
echo "Created: Rewrite .env.example"

# --- Issue 2 ---
gh issue create --repo "$REPO" \
  --title "Update README quickstart to remove .env editing requirement" \
  --label "dx,quick-win,documentation" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

The current README quickstart tells users to "Edit .env with your API keys" as a required step. This is no longer necessary — the admin UI handles all API key configuration at runtime.

**Current quickstart:**
```bash
git clone <repository-url>
cd ihub-apps
npm run setup:dev
# Edit .env with your API keys   ← THIS STEP SHOULDN'T EXIST
npm run dev
```

## Proposed Change

**New quickstart:**
```bash
git clone https://github.com/intrafind/ihub-apps.git
cd ihub-apps
npm run setup:dev
npm run dev
# Open http://localhost:3000 → Add your API key in Settings
```

**Docker quickstart (no -e OPENAI_API_KEY required):**
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

## Files
- `README.md`

## Impact
High — first impression transformation for every visitor.

## Effort
2-4 hours

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 1.2
ISSUE_EOF
)"
echo "Created: Update README quickstart"

# --- Issue 3 ---
gh issue create --repo "$REPO" \
  --title "Update setup:dev script to not require .env" \
  --label "dx,quick-win" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

`npm run setup:dev` currently copies `.env.example` → `.env` and tells the user to edit it. Since `.env` is no longer required (admin UI handles API keys), this step creates unnecessary confusion.

## Proposed Change

Skip the `.env` copy (or make it optional). Print a clear message:

```
✓ Dependencies installed
✓ Default configuration created

Ready! Run: npm run dev
Then open http://localhost:3000 to configure your AI providers.
```

## Files
- `package.json` (setup:dev script)
- Possibly `scripts/setup-dev.sh` or similar

## Impact
Medium — removes a confusing step in the onboarding flow.

## Effort
~30 minutes

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 1.3
ISSUE_EOF
)"
echo "Created: Update setup:dev script"

# --- Issue 4 ---
gh issue create --repo "$REPO" \
  --title "First-run setup wizard in browser" \
  --label "dx,admin-ui" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

When a user starts iHub Apps for the first time with no API keys, they see an app grid where every app will fail with "API key not found". There is no guidance on what to do next.

## Proposed Solution

Detect "unconfigured state" (no LLM provider has an API key) and show a lightweight setup wizard:

- **Step 1:** "Welcome to iHub Apps" — 1-sentence value prop
- **Step 2:** "Connect your first AI provider" — pick provider (Google free tier highlighted), paste key, "Test Connection" button
- **Step 3:** "You're all set!" — redirect to the chat app

### Key Design Decisions
- **Reuse existing infrastructure** — the admin providers page (`/admin/providers`) already has API key input, encryption, and test functionality. The wizard should wrap this existing logic, not duplicate it.
- **Detection:** New endpoint `GET /api/setup/status` → returns `{ configured: boolean }` based on whether any LLM provider has an API key (via `ApiKeyVerifier.validateEnabledModelsApiKeys()`)
- **Show only once** — once any key is configured, never show again
- **Skippable** — "Skip, I'll configure later" option

## Files
- **New:** `client/src/features/setup/SetupWizard.jsx`
- **New:** `server/routes/setup.js` (thin wrapper around existing provider/model logic)
- **Modify:** `client/src/App.jsx` (add route)
- **Modify:** `client/src/utils/runtimeBasePath.js` (add `/setup` to knownRoutes)
- **Reuse:** `server/routes/admin/providers.js` (existing API key save + test endpoints)
- **Reuse:** `server/utils/ApiKeyVerifier.js` (`validateEnabledModelsApiKeys()`)
- **Reuse:** `server/services/TokenStorageService.js` (encryption)

## Impact
Very high — transforms first impression from "broken" to "guided".

## Effort
3-4 days

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 2.1
ISSUE_EOF
)"
echo "Created: First-run setup wizard"

# --- Issue 5 ---
gh issue create --repo "$REPO" \
  --title "Add provider health dashboard to admin providers page" \
  --label "dx,admin-ui" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

The admin providers page (`/admin/providers`) shows providers and API key status, but has no connectivity health overview. Admins can only test models one-by-one from the separate models page.

## Proposed Solution

Enhance the existing providers admin page with health status:

- For each provider, show: name, API key status (configured/unconfigured), # enabled models, connectivity status
- "Test All" button that runs the existing model test endpoint for each enabled model of that provider
- Green/yellow/red status: all models working / some working / none working
- Expandable section per provider showing individual model test results

### Existing Code to Reuse
- Individual model testing: `POST /api/admin/models/{modelId}/test` (in `server/routes/admin/models.js`)
- Provider list with `apiKeySet` status: `GET /api/admin/providers`
- `ApiKeyVerifier.validateEnabledModelsApiKeys()` returns comprehensive status

## Files
- **Modify:** `client/src/features/admin/pages/AdminProvidersPage.jsx` (or equivalent provider admin component)
- **Optionally new:** `server/routes/admin/providerStatus.js` (bulk status endpoint)
- **Reuse:** `server/routes/admin/models.js` (existing test endpoint)
- **Reuse:** `server/utils/ApiKeyVerifier.js`

## Impact
Medium — admin efficiency, natural place for health info.

## Effort
2-3 days

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 2.2
ISSUE_EOF
)"
echo "Created: Provider health dashboard"

# --- Issue 6 ---
gh issue create --repo "$REPO" \
  --title "Restructure README as a conversion funnel" \
  --label "dx,documentation" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

The current README is ~1,434 lines — comprehensive but reads like reference documentation rather than a landing page. The value proposition is buried, and the quickstart is lost in the detail.

For a project with 17 GitHub stars despite genuine functionality, the README is the #1 conversion opportunity.

## Proposed Structure

1. **Hero** (5 lines): Tagline + badges + fastest install command
2. **Screenshot/GIF** (1 visual): App in action — user chatting with AI
3. **Quick Start** (10 lines max): 3 steps to running
4. **What's Included** (visual grid): Icons + names of the 19+ built-in apps
5. **Deploy Anywhere** (tabs): Docker | Binary | npm | Electron
6. **Extend** (links): Creating apps, adding models, auth setup → link to `/docs`
7. **Contributing** (brief)

Move everything else to `/docs`. The README should be a landing page, not a manual.

### Inspiration
- Coolify: immediately shows dashboard screenshot
- CapRover: "Scalable PaaS — aka Heroku on Steroids" — instant positioning
- Supabase CLI: multi-platform install tabs

## Files
- `README.md`
- Move content to `/docs`

## Impact
High — first impression for every GitHub visitor.

## Effort
1-2 days

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 5.1
ISSUE_EOF
)"
echo "Created: Restructure README"

# --- Issue 7 ---
gh issue create --repo "$REPO" \
  --title "Docker Hub publish + zero-config docker-compose" \
  --label "dx,distribution" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

Docker images are on GHCR (`ghcr.io/intrafind/ihub-apps:latest`) but many developers default to Docker Hub. The production docker-compose requires `.env.production` with pre-configured values.

## Proposed Solution

### Docker Hub
- Publish images to Docker Hub in addition to GHCR for discoverability
- Create a polished Docker Hub page with clear descriptions and usage examples

### Zero-config docker-compose
Ship a `docker-compose.quickstart.yml` that works with zero edits:

```yaml
services:
  ihub-apps:
    image: ghcr.io/intrafind/ihub-apps:latest
    ports: ["3000:3000"]
    volumes: ["./contents:/app/contents"]
```

No env vars needed — configure everything via browser after startup (admin UI handles API keys).

## Files
- **New:** `docker-compose.quickstart.yml`
- **Modify:** `.github/workflows/` (Docker Hub publish)
- **Modify:** `docker/DOCKER.md`

## Impact
Medium-high — simplest path for non-developers.

## Effort
3-5 days

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 3.2
ISSUE_EOF
)"
echo "Created: Docker Hub + zero-config compose"

# --- Issue 8 ---
gh issue create --repo "$REPO" \
  --title "Curl one-line installer + Homebrew tap" \
  --label "dx,distribution" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

iHub Apps already publishes 12 platform-specific binary assets per release, but there's no easy way to install them. Users must navigate to GitHub Releases manually.

## Proposed Solution

### Curl Installer (flagship installation method)

Following Coolify's pattern and Railway's short URL:

```bash
curl -fsSL https://ihub.app/install | sh
```

The `install.sh` script:
- Hosted at a memorable URL (`https://ihub.app/install` or GitHub raw URL)
- Detects OS (Linux/macOS/Windows) and architecture (x64/arm64)
- Checks for Docker — if available, offers to pull the image instead
- Downloads correct binary from GitHub Releases
- Verifies checksums after download
- Installs to `~/.local/bin` (no sudo required) or `/usr/local/bin`
- Generates a secure JWT secret automatically
- Wraps all logic in `main()` to prevent partial execution on network interruption
- Uses HTTPS exclusively
- Optional `--start` flag to launch after install

### Homebrew Tap

```bash
brew tap intrafind/ihub && brew install ihub
```

- Create `intrafind/homebrew-ihub` repo with a formula
- GitHub Actions workflow auto-updates the formula on each release (GoReleaser pattern)
- Formula downloads pre-built binary from GitHub Releases

Both methods install the `ihub` binary.

## Files
- **New:** `install.sh`
- **New repo:** `intrafind/homebrew-ihub`
- **Modify:** `.github/workflows/` (auto-update formula on release)

## Impact
High — meets developers on platforms they already use.

## Effort
~1 week

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 3.3
ISSUE_EOF
)"
echo "Created: Curl installer + Homebrew"

# --- Issue 9 ---
gh issue create --repo "$REPO" \
  --title "Enable \`npx ihub\` for zero-install trial" \
  --label "dx,distribution" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

There's no way to try iHub Apps without cloning the repo. Modern tools like `npx create-react-app` and `npx serve` let developers try things in seconds.

## Proposed Solution

Make `npx ihub` work:

1. Rename bin entry from `ihub-apps` to `ihub`
2. Pre-build client and include `client/dist/` in npm package
3. Add `"files"` field to `package.json` to control published contents
4. Ensure `sea-server.cjs` runs `performInitialSetup()` on startup
5. Add `"publishConfig"` to `package.json`
6. Set up npm publish in CI/CD pipeline
7. `npx ihub` → starts server → opens browser → shows setup wizard

### Future: `npx create-ihub-app`

Following the `create-*` pattern (Next.js, Vite, Svelte):
```bash
npx create-ihub-app my-ai-hub
# → Interactive wizard: pick provider, paste key, choose apps
# → Scaffolds a directory with config + starts server
```

This would be a separate npm package and lower priority than `npx ihub`.

## Files
- **Modify:** `package.json` (bin, files, publishConfig)
- **Modify:** `server/sea-server.cjs`
- **Modify:** `.github/workflows/` (npm publish pipeline)

## Impact
Very high — the gold standard for discoverability.

## Effort
1-2 weeks (mostly CI/CD and testing)

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 3.1
ISSUE_EOF
)"
echo "Created: npx ihub support"

# --- Issue 10 ---
gh issue create --repo "$REPO" \
  --title "\`ihub\` CLI with noun-verb subcommands" \
  --label "dx,cli" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

The current binary launcher only starts the server — no `--help`, `--version`, or subcommands. All interaction goes through `npm run *` scripts, which lacks the polish of tools like Railway CLI, Coolify, or Supabase CLI.

## Proposed Solution

Build a proper CLI following the **noun-verb pattern**:

```
# ─── Core lifecycle ───
ihub start              # Start the server (replaces npm run dev / npm start)
ihub stop               # Stop a running instance
ihub setup              # Interactive first-run wizard (terminal-based)
ihub open               # Open browser to running instance
ihub status             # Show version, uptime, providers, models, active users
ihub update             # Self-update to latest version
ihub doctor             # Diagnose: ports, API keys, connectivity, config, disk

# ─── App management ───
ihub apps list          # Show configured apps (name, model, enabled status)
ihub apps add           # Interactive app creation wizard
ihub apps enable <id>   # Enable a disabled app
ihub apps disable <id>  # Disable an app

# ─── Model management ───
ihub models list        # Show configured models (name, provider, API key status)
ihub models add         # Interactive model addition
ihub models test <id>   # Test a specific model's connectivity

# ─── Configuration ───
ihub config show        # Print current resolved config
ihub config edit        # Open config in $EDITOR
ihub config reset       # Reset to defaults (with confirmation)

# ─── Data management ───
ihub logs               # Stream server logs (--level error, --since 1h)
ihub backup             # Archive contents/ directory with timestamp
ihub restore <file>     # Restore from a backup archive
```

### Implementation Details
- Use `@clack/prompts` for beautiful terminal UI (spinners, select menus, confirmations)
- Every command works interactively AND with flags: `ihub apps add --name "Bot" --model gpt-4o --system "..."`
- Shell completions: `ihub completions bash|zsh|fish|powershell`
- Rich `--help` with examples on every command

### Example `ihub doctor` Output
```
✓ Node.js v24.1.0
✓ Port 3000 available
✓ OpenAI API key configured
✗ Anthropic API key missing — set via admin UI or ANTHROPIC_API_KEY
✓ Google API key configured
✓ 3 models responding
✗ 2 models unreachable — run "ihub models test" for details
✓ Config files valid
✓ 847 MB disk space available
```

## Files
- **New:** `cli/` directory with command modules (or extend `server/sea-server.cjs`)

## Impact
High — transforms the product from "Node.js project" to "proper developer tool".

## Effort
2-3 weeks

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 3.4
ISSUE_EOF
)"
echo "Created: ihub CLI subcommands"

# --- Issue 11 ---
gh issue create --repo "$REPO" \
  --title "Slim down platform.json: convention over configuration" \
  --label "dx,configuration" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

`server/defaults/config/platform.json` is 144 lines. Most fields (rate limiting, CORS, PDF export, logging, JWT algorithm) have sane defaults that 95% of users never change. The file is intimidating for new users and easy to misconfigure.

## Proposed Solution

Move defaults into code. Ship a minimal `platform.json`:

```json
{
  "defaultLanguage": "en",
  "auth": { "mode": "local" },
  "anonymousAuth": { "enabled": true, "defaultGroups": ["anonymous"] },
  "localAuth": { "enabled": true }
}
```

`configCache.js` applies programmatic defaults via `mergeDefaults()` for everything else. Power users can still override any field by adding it to their `platform.json`.

## Files
- **Modify:** `server/configCache.js` (apply programmatic defaults)
- **Modify:** `server/defaults/config/platform.json` (slim to ~20 lines)

## Impact
Medium — less intimidating config, fewer things to misconfigure.

## Effort
3-5 days (careful backward-compatibility testing needed)

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 4.1
ISSUE_EOF
)"
echo "Created: Slim down platform.json"

# --- Issue 12 ---
gh issue create --repo "$REPO" \
  --title "Comprehensive IHUB_* environment variable overrides" \
  --label "dx,configuration" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

Only ~20 environment variables are supported (provider keys, port, proxy, SSL). There is no systematic mapping from config fields to env vars. This makes Docker/Kubernetes deployments harder than necessary, since environment variables are the native configuration mechanism for containers.

## Proposed Solution

Every JSON config value should have a corresponding `IHUB_*` env var override:

```bash
IHUB_AUTH_MODE=anonymous         # → platform.json auth.mode
IHUB_DEFAULT_LANGUAGE=de         # → platform.json defaultLanguage
IHUB_THEME=dark                  # → ui.json theme
IHUB_SESSION_TIMEOUT=60          # → platform.json auth.sessionTimeoutMinutes
IHUB_RATE_LIMIT_DEFAULT=200      # → platform.json rateLimit.default.limit
```

### Implementation
- In `configCache.js`, after loading JSON configs, scan for `IHUB_*` env vars and apply as overrides
- Use dot-path convention: `IHUB_AUTH_MODE` maps to `auth.mode` (underscores = dots in nested paths)
- Document all available env vars in `/docs`

## Files
- **Modify:** `server/configCache.js`
- **Add:** Documentation in `/docs`

## Impact
Medium — unlocks container orchestration and 12-factor app patterns.

## Effort
3-5 days

## Part of
[Usability Simplification Roadmap](concepts/2026-03-09%20Usability%20Simplification%20Roadmap.md) — Phase 4.2
ISSUE_EOF
)"
echo "Created: IHUB_* env var overrides"

echo ""
echo "✅ All 12 issues created successfully!"
echo ""
echo "Issues map to the Usability Simplification Roadmap:"
echo "  Phase 1 (Quick Wins):   Issues 1-3"
echo "  Phase 2 (First-Run UX): Issues 4-5"
echo "  Phase 3 (Distribution): Issues 7-10"
echo "  Phase 4 (Config):       Issues 11-12"
echo "  Phase 5 (README):       Issue 6"
