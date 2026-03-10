# iHub Apps — Simplification Proposal

**Date:** 2026-03-09
**Goal:** Make iHub Apps dramatically easier to download, install, configure, use, understand, and maintain.

---

## Executive Summary

iHub Apps is a powerful, feature-rich platform — but that power comes with friction. A new user currently faces: a Node.js 24+ requirement, 50+ JSON config files, 7 authentication middlewares, 13 config files in `/contents/config/` alone, 40+ npm scripts, and documentation scattered across 85 markdown files.

This proposal organizes simplification into **7 pillars**, each with concrete, actionable ideas ranked by impact.

---

## Pillar 1: Zero-Friction Installation

### Problem
Today's installation requires: clone repo → ensure Node 24+ → `npm run setup:dev` → manually edit `.env` with API keys → `npm run dev`. That's 5 steps before seeing anything, and the Node 24 requirement alone blocks most developers.

### Ideas

**1.1 — `npx create-ihub-app` (High Impact)**

Create an `create-ihub-app` npm package that provides a guided, interactive setup:

```bash
npx create-ihub-app my-instance
# → Asks: Which LLM providers? (checkboxes: OpenAI, Anthropic, Google, Local)
# → Asks: Auth mode? (Anonymous / Local passwords / OIDC)
# → Asks: Paste your API key for OpenAI: sk-...
# → Generates .env, strips unused model configs, starts server
# → Opens browser to http://localhost:3000
```

This is the pattern used by Next.js, Vite, and every modern framework. It eliminates the "read docs first" problem entirely.

**1.2 — Homebrew & System Package Managers (Medium Impact)**

```bash
brew install ihub-apps        # macOS
winget install ihub-apps      # Windows
curl -fsSL https://get.ihub-apps.dev | sh   # Linux/macOS universal
```

The SEA (Single Executable Application) binary already exists — it just needs proper distribution. Publish it to Homebrew tap, a Windows installer, and a shell script that downloads the right binary for the platform.

**1.3 — One-Line Docker Start (Medium Impact)**

```bash
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... ghcr.io/intrafind/ihub-apps
```

Publish the Docker image to GitHub Container Registry or Docker Hub. No git clone needed. Mount a volume for persistence if wanted.

**1.4 — Lower the Node.js Floor (Quick Win)**

The `"engines": { "node": ">=24.0.0" }` requirement is extremely aggressive. Node 24 was only released recently. Drop this to Node 20 (the current LTS) or Node 22. Most of the codebase doesn't use Node 24-specific APIs — the few that do can be polyfilled or guarded.

**1.5 — Pre-Built Binaries on GitHub Releases (Medium Impact)**

Automate the SEA build in CI/CD. Every tagged release should produce:
- `ihub-apps-linux-x64`
- `ihub-apps-darwin-arm64`
- `ihub-apps-darwin-x64`
- `ihub-apps-win-x64.exe`

Users download one file, run it, done.

---

## Pillar 2: Configuration Simplification

### Problem
The `contents/config/` directory has 13 JSON files totaling 2,267 lines. `tools.json` alone is 946 lines. There's no schema validation in the admin UI, so a typo in JSON breaks things silently. New users don't know which files matter and which are optional.

### Ideas

**2.1 — Sensible Defaults with Override Pattern (High Impact)**

Ship a single `ihub-apps.config.js` (or `.json` or `.yaml`) at the project root that contains only the user's overrides. Everything else falls back to built-in defaults. Today, the user must understand 13 files. With this approach:

```js
// ihub-apps.config.js — the ONLY file users need to touch
export default {
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  auth: { mode: 'anonymous' },   // or 'local', 'oidc'
  // Everything else: sensible defaults
}
```

Internally, deep-merge user config over defaults. The 13 separate files can remain for power users, but new users never see them.

**2.2 — Setup Wizard in the Admin UI (High Impact)**

On first launch (no `platform.json` found or a `firstRun: true` flag), redirect to an interactive setup wizard:

1. **Welcome** → Name your instance
2. **LLM Providers** → Enter API keys, test connectivity with a "Verify" button
3. **Authentication** → Pick a mode, configure it inline
4. **First App** → Choose from templates or create a quick chatbot
5. **Done** → Writes all config files automatically

This eliminates the need to hand-edit JSON entirely for the common case.

**2.3 — Merge Small Config Files (Medium Impact)**

Several config files are tiny and could be sections of a larger file:

| Current Files | Proposed Merge |
|---|---|
| `features.json` (4 lines), `styles.json` (18 lines), `registries.json` (14 lines), `installations.json` (1 line) | Fold into `platform.json` as sections |
| `oauth-clients.json` (8 lines) | Fold into `platform.json` under `auth.oauthClients` |
| `mimetypes.json` (270 lines) | Move to `server/defaults/` — users almost never customize this |

This reduces the visible config surface from 13 files to ~7 files.

**2.4 — JSON Schema + Validation (Medium Impact)**

Create JSON Schema files for every config type. Benefits:
- **Admin UI** can render forms from schemas instead of raw JSON editors
- **Startup validation** catches typos before they cause runtime errors
- **IDE support** — users editing config in VS Code get autocomplete and error highlighting
- **Documentation** — schemas serve as living documentation

**2.5 — Split `tools.json` (Quick Win)**

At 946 lines, `tools.json` is the largest config file. Follow the pattern already used for apps and models: one file per tool in a `contents/tools/` directory. This makes individual tools much easier to understand, enable/disable, and version-control.

---

## Pillar 3: Simplified Authentication

### Problem
Seven auth middlewares (JWT, Local, OIDC, Proxy, LDAP, NTLM, Teams) make the auth system powerful but daunting. New users just want "it works" and enterprise users want "it plugs into our SSO." The middle ground — understanding all 7 options — serves nobody well.

### Ideas

**3.1 — Auth Profiles Instead of Middleware Soup (High Impact)**

Offer three named profiles that abstract away the middleware details:

| Profile | What It Does | When to Use |
|---|---|---|
| `open` | No auth at all | Development, demos, internal trusted networks |
| `built-in` | Local usernames + passwords with JWT | Small teams, quick deployments |
| `enterprise` | OIDC / LDAP / NTLM / Proxy (auto-detected from config) | Corporate SSO integration |

The user picks one word in config. The system wires up the right middlewares automatically.

```json
{ "auth": { "profile": "built-in" } }
```

Power users can still configure individual middlewares, but the profile abstraction handles 90% of cases.

**3.2 — Auth Connection Tester (Medium Impact)**

In the admin UI, add a "Test Connection" button for each auth provider. Today, if OIDC is misconfigured, the user sees a cryptic error at login time. A test button that validates the OIDC discovery endpoint, client credentials, and redirect URIs before saving would save hours of debugging.

**3.3 — Built-In Demo Mode (Quick Win)**

A single env var or flag:

```bash
ihub-apps --demo
# or
IHUB_DEMO=true npm run dev
```

Starts with anonymous auth, a sample chat app, and a mock LLM provider that returns canned responses. No API keys needed. Perfect for evaluation, demos, and UI development.

---

## Pillar 4: Streamlined Developer Experience

### Problem
40+ npm scripts, a monorepo with 3 separate `package.json` files, and scattered test configurations create cognitive overhead. The `package.json` scripts section is 100+ lines — a developer scanning it won't know where to start.

### Ideas

**4.1 — Reduce npm Scripts to Essentials (High Impact)**

Today: 40+ scripts. Proposed: expose ~10 top-level scripts, move the rest to a `scripts/` directory.

```json
{
  "scripts": {
    "setup": "node scripts/setup.js",
    "dev": "node scripts/dev.js",
    "build": "node scripts/build.js",
    "start": "node scripts/start.js",
    "test": "node scripts/test.js",
    "lint": "eslint . --fix && prettier --write .",
    "docker": "node scripts/docker.js"
  }
}
```

Each script file handles sub-commands internally:
```bash
npm run docker           # interactive: build? run? up?
npm run docker -- build  # direct: build production image
npm test                 # runs unit tests
npm test -- --e2e        # runs e2e tests
npm test -- --all        # runs everything
```

This is the pattern used by tools like Turborepo and Angular CLI — a clean top-level with depth available when needed.

**4.2 — Unified `package.json` (Medium Impact)**

Consider using npm workspaces properly or migrating to a build tool like Turborepo. The current `npm run install:all` (which manually `cd`s into client and server) is fragile. With workspaces:

```json
{
  "workspaces": ["client", "server"]
}
```

Then `npm install` at root handles everything. No more `install:all` script.

**4.3 — Remove mdbook/Rust Build Dependency (Medium Impact)**

The documentation build requires Rust (for mdbook), which adds minutes to Docker builds and surprises developers. Alternatives:
- **Docusaurus** or **VitePress** — JavaScript-native, zero new toolchains
- **Pre-build docs in CI** — Ship pre-built HTML, don't require users to build docs locally
- **Markdown-only** — Serve docs as rendered markdown in the app (the admin UI could have a built-in docs viewer)

This removes the Rust installation from the Dockerfile entirely, cutting build time significantly.

**4.4 — Simplify `configCache.js` (Medium Impact)**

At 1,465 lines, `configCache.js` is doing too much. Split it into:
- `configLoader.js` — File I/O, JSON parsing, file watching
- `configValidator.js` — Schema validation, error reporting
- `configCache.js` — Pure cache (get/set/invalidate)
- `configDefaults.js` — Default values and merging logic

Each file becomes ~300-400 lines and has a single responsibility.

**4.5 — Hot Reload for All Config (Quick Win)**

Some config changes require server restart, some don't. Make them all hot-reloadable. Today the user has to remember which is which — that's unnecessary cognitive load.

---

## Pillar 5: Simplified App & Model Management

### Problem
Creating a new AI app requires writing a JSON file with 30+ possible fields, understanding the schema, and placing it in the right directory. Model configs similarly require understanding provider-specific details. The admin UI helps, but new users often start with files.

### Ideas

**5.1 — App Templates / Quickstart Gallery (High Impact)**

In the admin UI, offer a "Create App" flow with templates:

- **Simple Chatbot** — Just a system prompt, done
- **Document Analyzer** — File upload + system prompt
- **Code Assistant** — Code-focused with syntax highlighting
- **Custom** — Full JSON editor for power users

Each template pre-fills 80% of the config. The user just writes their system prompt and picks a name.

**5.2 — Model Auto-Discovery (Medium Impact)**

Instead of manually creating model JSON files, auto-discover available models:
- For OpenAI: call `/v1/models` endpoint
- For Anthropic: use known model list
- For local providers (LM Studio, vLLM): probe the endpoint

Show discovered models in admin UI → user clicks to enable → config file auto-generated.

**5.3 — App Configuration Profiles (Medium Impact)**

Many app config fields are rarely changed from defaults. Introduce profiles:

```json
{
  "profile": "chatbot",
  "name": { "en": "My Assistant" },
  "system": { "en": "You are a helpful assistant." }
}
```

The `chatbot` profile provides sensible defaults for `tokenLimit`, `sendChatHistory`, `preferredOutputFormat`, etc. Users only override what they need.

**5.4 — Inline Documentation in Admin UI (Quick Win)**

Every config field in the admin editor should have a `(?)` tooltip explaining what it does, valid values, and an example. Today, users must cross-reference the 37KB `apps.md` documentation file while editing config — that's a poor experience.

---

## Pillar 6: Better Onboarding & Documentation

### Problem
85 markdown files across `/docs/`, multiple getting-started guides, and documentation that requires a Rust toolchain to build. A new user doesn't know whether to read `GETTING_STARTED.md`, `INSTALLATION.md`, or `developer-onboarding.md` first.

### Ideas

**6.1 — Single-Page Quick Start (High Impact)**

Replace the multiple getting-started documents with one authoritative page. The entire quick start should fit on one screen:

```
# Quick Start

1. npx create-ihub-app my-instance
2. Open http://localhost:3000
3. Start chatting

# Want more?
→ [Configuration Guide](./configuration.md)
→ [Authentication Setup](./authentication.md)
→ [Adding Custom Apps](./apps.md)
```

Three lines to get started. Everything else is progressive disclosure.

**6.2 — Interactive In-App Tutorial (Medium Impact)**

On first launch, a guided tour highlights key UI elements:
1. "This is your app gallery — click any app to start chatting"
2. "Here's the admin panel — configure models and users"
3. "Click here to create your first custom app"

Libraries like `react-joyride` or `shepherd.js` make this straightforward.

**6.3 — Consolidate Documentation Structure (Medium Impact)**

Reduce 85 docs to ~20 well-organized documents:

```
docs/
├── quick-start.md           # 1-page getting started
├── installation.md          # All installation methods (npm, Docker, binary)
├── configuration.md         # Unified config reference
├── authentication.md        # All auth modes in one place
├── apps.md                  # Creating and managing apps
├── models.md                # Model configuration
├── tools.md                 # Tool system
├── api-reference.md         # REST API docs
├── deployment.md            # Production deployment
├── troubleshooting.md       # Common issues & fixes
└── advanced/                # Deep dives for power users
    ├── architecture.md
    ├── custom-adapters.md
    ├── migrations.md
    └── ...
```

The key principle: new users see 10 documents max. Advanced topics are one click deeper.

**6.4 — Built-In API Explorer (Quick Win)**

Swagger/OpenAPI already exists in the codebase (`swagger.js`). Expose it prominently in the admin UI as an interactive API explorer. This replaces the need for separate API documentation.

---

## Pillar 7: Operational Simplification

### Problem
Running iHub Apps in production involves: choosing between 3 Docker Compose files, configuring clustering, understanding the migration system, managing encrypted secrets, and monitoring health across workers. This is enterprise-grade infrastructure complexity.

### Ideas

**7.1 — Single Docker Compose with Profiles (High Impact)**

Replace three Docker Compose files with one that uses Docker Compose profiles:

```yaml
# docker-compose.yml (the only file)
services:
  ihub:
    profiles: ["dev", "prod"]
    build:
      target: ${IHUB_TARGET:-production}
    # ...
```

```bash
docker compose up                    # production (default)
docker compose --profile dev up      # development with hot reload
```

One file, no confusion about which to use.

**7.2 — Health Dashboard (Medium Impact)**

Add a simple `/admin/health` page showing:
- Server uptime and worker status
- LLM provider connectivity (green/yellow/red per provider)
- Config validation status
- Recent errors
- Memory/CPU usage

Currently, `npm run health` just curls an endpoint. A visual dashboard makes operations intuitive.

**7.3 — `ihub-apps doctor` Command (Medium Impact)**

A diagnostic command that checks everything:

```bash
npx ihub-apps doctor
# ✅ Node.js 24.1.0
# ✅ All dependencies installed
# ✅ .env file found
# ✅ OpenAI API key valid (tested)
# ❌ Anthropic API key missing
# ✅ Port 3000 available
# ✅ Config files valid
# ⚠️ tools.json: deprecated field 'legacyMode' found
```

This eliminates the guesswork of "why isn't it working?"

**7.4 — Automatic Config Backup (Quick Win)**

Before any migration or admin UI config change, automatically snapshot the `contents/` directory. Store the last 5 snapshots. This gives users confidence to experiment with configuration without fear of breaking things.

---

## Implementation Priority Matrix

| Idea | Impact | Effort | Priority |
|---|---|---|---|
| 1.1 `npx create-ihub-app` | 🔴 High | Medium | **P0** |
| 1.4 Lower Node.js floor | 🔴 High | Low | **P0** |
| 2.1 Single config file with defaults | 🔴 High | Medium | **P0** |
| 2.2 Setup wizard in admin UI | 🔴 High | High | **P1** |
| 3.1 Auth profiles | 🔴 High | Medium | **P1** |
| 3.3 Demo mode | 🟡 Medium | Low | **P1** |
| 4.1 Reduce npm scripts | 🟡 Medium | Low | **P1** |
| 6.1 Single-page quick start | 🔴 High | Low | **P1** |
| 7.3 Doctor command | 🟡 Medium | Low | **P1** |
| 1.2 Homebrew / system packages | 🟡 Medium | Medium | **P2** |
| 1.3 One-line Docker start | 🟡 Medium | Low | **P2** |
| 1.5 Pre-built binaries in CI | 🟡 Medium | Medium | **P2** |
| 2.3 Merge small config files | 🟡 Medium | Low | **P2** |
| 2.4 JSON Schema + validation | 🟡 Medium | Medium | **P2** |
| 2.5 Split tools.json | 🟢 Low | Low | **P2** |
| 4.2 Unified package.json workspaces | 🟡 Medium | Medium | **P2** |
| 4.3 Remove mdbook/Rust dependency | 🟡 Medium | Medium | **P2** |
| 4.4 Simplify configCache.js | 🟡 Medium | Medium | **P2** |
| 5.1 App templates gallery | 🟡 Medium | Medium | **P2** |
| 5.2 Model auto-discovery | 🟡 Medium | Medium | **P2** |
| 6.3 Consolidate docs to ~20 files | 🟡 Medium | Medium | **P2** |
| 7.1 Single Docker Compose with profiles | 🟡 Medium | Low | **P2** |
| 5.3 App config profiles | 🟢 Low | Low | **P3** |
| 5.4 Inline docs in admin UI | 🟢 Low | Low | **P3** |
| 4.5 Hot reload all config | 🟢 Low | Medium | **P3** |
| 6.2 Interactive tutorial | 🟢 Low | Medium | **P3** |
| 6.4 Built-in API explorer | 🟢 Low | Low | **P3** |
| 7.2 Health dashboard | 🟢 Low | Medium | **P3** |
| 7.4 Automatic config backup | 🟢 Low | Low | **P3** |
| 3.2 Auth connection tester | 🟢 Low | Medium | **P3** |

---

## The "5-Minute Promise"

If we implement the P0 and P1 items, the new user experience becomes:

```bash
# Minute 0-1: Install
npx create-ihub-app my-assistant
# Interactive: pick providers, paste one API key, choose "open" auth

# Minute 1-2: Start
cd my-assistant && npm run dev

# Minute 2-3: Browser opens, setup wizard runs (if anything was skipped)

# Minute 3-5: User is chatting with their first AI app
```

Compare to today's experience, which involves reading installation docs, understanding monorepo structure, configuring 5+ environment variables, and hoping nothing goes wrong — easily a 30-60 minute process.

The goal is not to remove features. It's to hide complexity behind progressive disclosure: simple by default, powerful when you need it.

---

## Summary of Key Metrics (Current → Target)

| Metric | Current | Target |
|---|---|---|
| Time to first working instance | 30-60 min | < 5 min |
| Config files a new user must understand | 13+ | 1 |
| npm scripts in package.json | 40+ | ~10 |
| Documentation files to navigate | 85 | ~20 (10 top-level) |
| Node.js version required | 24+ | 20+ (LTS) |
| Steps to install | 5+ manual steps | 1 command |
| Auth modes to choose from | 7 (undifferentiated) | 3 profiles |
| Docker Compose files | 3 | 1 |
