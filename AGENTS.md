# Repository Guide for Codex

This document gives informations and instructions for working with the **ihub-apps** repository. **ihub-apps** is a platform which hosts ai-enabled apps. ai-enabled apps allow the user to communicate with the ai, but without the need to know how to prompt. The goal is to allow companies to customize it without the need of coding.

## Project Overview

- **Client**: React application located in `client/`.
- **Server**: Node.js backend under `server/`.
- **Shared**: code which is shared between Client and Server lives in `shared/`.
- **Configs**: configuration for our application lives in `contents`
- **Examples**: example as well as customer-specific configurations are located in `examples`
- **Concepts**: Concepts for each feature are located in `concepts`
- **Documentation**: documentation sources are in `docs/`. The rendered docs are copied to `public/help` during production builds.

## Setup

1. Install all dependencies for client and server:
   ```bash
   npm run install:all
   npx playwright install    # required for screenshot tools
   ```
   Chrome/Chromium must be available in your `PATH` for Selenium tools.
   Alternatively you can call:
   ```bash
   ./setup.sh
   ```
   which will run npm install for server and client
2. Copy `config.env` and set the required API keys (e.g. `OPENAI_API_KEY`).

## Concepts

Every new feature, will have a concept in the folder concept folder. Always check the concept regarding information. When implementing new features, make sure that an concept document exists. If none exists, always make sure to create one.
If one exists, make sure that you update it with decisions we have taken and where code related to the feature can be found.
Always store them in the concepts folder `concepts` and format them `{year}-{month}-{day} {title}.md`

## Development

### Code Quality and Linting

**CRITICAL**: The project uses automated linting and formatting. Always ensure code quality before making changes:

**Available Commands:**

```bash
# Check all files for linting issues
npm run lint

# Auto-fix linting issues where possible (ALWAYS run before committing)
npm run lint:fix

# Format all files with Prettier
npm run format

# Check if files are properly formatted
npm run format:fix
```

**Automated Systems:**

- **Pre-commit hooks**: Husky automatically runs `lint-staged` on commit
- **CI/CD**: GitHub Actions runs linting checks on all PRs and pushes
- **ESLint 9.x**: Modern flat config format (`eslint.config.js`)
- **Prettier**: Consistent code formatting (`.prettierrc`)

**Required Workflow:**

1. **Before coding**: Run `npm run lint:fix` to fix existing issues
2. **During coding**: Use your IDE's ESLint/Prettier integration
3. **Before committing**: Pre-commit hooks will automatically run
4. **If hook fails**: Fix issues and commit again

**IMPORTANT**: Pre-commit hooks will prevent commits with linting errors. Always run `npm run lint:fix` before committing.

### Development Environment

Start the development environment which runs both client and server:

```bash
# Start development with linting check
npm run lint:fix && npm run format:fix && npm run dev
```

The server listens on port `3000` by default and the Vite dev server handles the frontend with hot reloading.
Always use port 5173 for testing the frontend, because 3000 is only the server api.

## Production Build

To create a full production build:

```bash
npm run prod:build
```

Start the production build with:

```bash
npm run start:prod
```

A standalone binary can be created with `./build.sh --binary` if Node.js 20+ is installed.

## Testing

This repository does not contain automated tests yet.

### Manual Server Startup Testing

After any code changes, especially to server architecture, imports, or dependencies, always test that the server starts correctly:

```bash
# ALWAYS run linting first, then formatting
npm run lint:fix

# ALWAYS run formatting, then test server startup
npm run format:fix

# Test server startup with timeout to catch errors quickly
timeout 10s node server/server.js || echo "Server startup check completed"

# Test full development environment
timeout 15s npm run dev || echo "Development environment startup check completed"
```

**Critical**: This testing must be done after every build or significant refactoring to ensure:

- No linting errors that could break functionality
- No import/export errors
- No missing dependencies
- Server starts without runtime errors
- All modules load correctly
- Code follows established style guidelines

Common issues to watch for:

- Linting violations (run `npm run lint:fix` first)
- Formaating violations (run `npm run format:fix` first)
- Import path mismatches (e.g., `import from './utils.js'` when function is in `./usageTracker.js`)
- Variable scope issues (e.g., variables declared in wrong scope)
- Missing module exports
- Syntax errors
- Formatting inconsistencies

## Guidelines

Follow the instructions in [LLM_GUIDELINES.md](LLM_GUIDELINES.md):

- Preserve existing functionality and architecture.
- Keep UI layout and styles intact unless the task requires changes.
- Maintain configuration schemas when editing JSON files in `contents/config`.
- Update code comments when modifying logic and preserve error handling.
- Important! Whenever you get an API_KEY for adapters, tools or anything else, NEVER EVER write them into the code or documentation. Always use a placeholder.

Always consult the documentation in `docs/` for additional details about configuration files and features.

### Secret Encryption at Rest

Platform config secrets are encrypted on disk in `platform.json` using `TokenStorageService` (AES-256-GCM). The encryption key is at `contents/.encryption-key`.

**Encrypted format:** `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`

**Encrypted fields:** `jira.clientSecret`, `cloudStorage.providers[].clientSecret`, `cloudStorage.providers[].tenantId` (office365), `oidcAuth.providers[].clientSecret`, `ldapAuth.providers[].adminPassword`, `ntlmAuth.domainControllerPassword`

**Guard pattern:** When encrypting, always skip empty values, env var placeholders (`${VAR}`), and already-encrypted values (`ENC[...]`).

**Key files:**

- `server/services/TokenStorageService.js` — `encryptString()`, `decryptString()`, `isEncrypted()`
- `server/routes/admin/configs.js` — encrypt on save, decrypt on read
- `server/configCache.js` — decrypt at runtime for all consumers

## Internationalization (i18n)

- Every user-facing string or configuration key must be internationalized.
- Provide translations for at least English (`en`) and German (`de`).
- Update the relevant translation files when adding or modifying keys:
  - Built-in translations: `shared/i18n/{lang}.json`
  - Override keys: `contents/locales/{lang}.json`
- Never assume English is the default. The default language is configured in the
  backend's `platform.json` file.
