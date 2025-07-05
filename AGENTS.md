# Repository Guide for Codex

This document gives Codex instructions for working with the **ai-hub-apps** repository.

## Project Overview
- **Client**: React application located in `client/`.
- **Server**: Node.js backend under `server/`.
- **Shared** code lives in `shared/`.
- Documentation sources are in `docs/`. The rendered docs are copied to `public/help` during production builds.

## Setup
1. Install all dependencies for client and server:
   ```bash
   npm run install:all
   npx playwright install    # required for screenshot tools
   ```
   Chrome/Chromium must be available in your `PATH` for Selenium tools.
2. Copy `config.env` and set the required API keys (e.g. `OPENAI_API_KEY`).

## Development
Start the development environment which runs both client and server:
```bash
npm run dev
```
The server listens on port `3000` by default and the Vite dev server handles the frontend with hot reloading.

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
This repository does not contain automated tests. Manual testing is described in `docs/web-tools.md` using the example script `test-web-tools.js` when available.

## Guidelines
Follow the instructions in [LLM_GUIDELINES.md](LLM_GUIDELINES.md):
- Preserve existing functionality and architecture.
- Keep UI layout and styles intact unless the task requires changes.
- Maintain configuration schemas when editing JSON files in `contents/config`.
- Update code comments when modifying logic and preserve error handling.

Always consult the documentation in `docs/` for additional details about configuration files and features.
