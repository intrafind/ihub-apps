# Repository Guide for Codex

This document gives informations and instructions for working with the **ai-hub-apps** repository. **ai-hub-apps** is a platform which hosts ai-enabled apps. ai-enabled apps allow the user to communicate with the ai, but without the need to know how to prompt. The goal is to allow companies to customize it without the need of coding.

## Project Overview
- **Client**: React application located in `client/`.
- **Server**: Node.js backend under `server/`.
- **Shared**: code which is shared between Client and Server lives in `shared/`.
- **Configs**: configuration for our application lives in `contents`
- **Examples**: example as well as customer-specific configurations are located in `examples`
- **Concepts**: Concepts for each feature are located in `concepts`
- **Documentation**: documentation sources  are in `docs/`. The rendered docs are copied to `public/help` during production builds.

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
3. Copy `config.env` and set the required API keys (e.g. `OPENAI_API_KEY`).

## Concepts
Every new feature, will have a concept in the folder concept folder. Always check the concept regarding information. When implementing new features, make sure that an concept document exists. If none exists, always make sure to create one.
If one exists, make sure that you update it with decisions we have taken and where code related to the feature can be found.
Always store them in the concepts folder `concepts` and format them `{year}-{month}-{day} {title}.md`

## Development
Start the development environment which runs both client and server:
```bash
npm run dev
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
A standalone binary can be created with `./build.sh --binary` if Node.js 22+ is installed.

## Testing
This repository does not contain automated tests yet.

## Guidelines
Follow the instructions in [LLM_GUIDELINES.md](LLM_GUIDELINES.md):
- Preserve existing functionality and architecture.
- Keep UI layout and styles intact unless the task requires changes.
- Maintain configuration schemas when editing JSON files in `contents/config`.
- Update code comments when modifying logic and preserve error handling.

Always consult the documentation in `docs/` for additional details about configuration files and features.
