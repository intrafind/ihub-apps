# GitHub Copilot Instructions for iHub Apps

This is a full-stack AI application platform built with **Node.js (Express)** and **React**, enabling companies to deploy and customize AI-powered applications without coding. The platform supports multiple LLM providers (OpenAI, Anthropic, Google, Mistral), flexible authentication (Anonymous, Local, OIDC, Proxy), and enterprise-grade features.

## Project Structure

- **`client/`**: React application (Vite + Tailwind CSS) with hot reload
- **`server/`**: Node.js Express backend with LLM adapters and authentication
- **`shared/`**: Code shared between client and server (utilities, i18n)
- **`contents/`**: JSON configuration files for apps, models, UI, groups, sources, tools
- **`examples/`**: Example and customer-specific configuration templates
- **`concepts/`**: Feature concept documents, design docs, RFCs (format: `YYYY-MM-DD {title}.md`)
- **`docs/`**: User-facing feature documentation (rendered to `/help` in production)
- **`tests/`**: Test files for server components and integrations

## Quick Setup

For new development environments, run:

```bash
# Quick setup (copies .env, installs all dependencies)
npm run setup:dev

# Edit .env with your API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)

# Start development environment (server on :3000, client on :5173)
npm run dev
```

### Additional Setup Notes

- Chrome/Chromium must be available in `PATH` for Playwright tools: `npx playwright install`
- API keys are loaded from `.env` file (never commit API keys to the repository)
- Server runs on port 3000, Vite dev server on port 5173
- Access frontend at `http://localhost:5173` during development

## Concepts and Documentation

### Feature Documentation (docs/)

**All user-facing feature documentation should be added to the `docs/` folder:**

**When to Update Existing Documentation:**
- **Always check first** if documentation already exists in `docs/` for the area you're working on
- Update existing files rather than creating new ones when the feature fits within an existing document
- For example:
  - New model features → add to `docs/models.md`
  - New UI features → add to `docs/ui.md`
  - New authentication features → add to `docs/authentication-architecture.md`
  - New configuration → add to relevant config docs

**When to Create New Documentation:**
- Only create new documentation files when the feature doesn't fit into any existing document
- Use descriptive, lowercase filenames with hyphens: `feature-name.md`
- Add the new file to `docs/SUMMARY.md` for inclusion in the documentation site

**Documentation Structure:**
- `docs/` - User-facing feature documentation, guides, and references
  - Updated as features are added or modified
  - Organized by topic (models, authentication, configuration, etc.)
  - Rendered on the documentation site at `/help`

### Concept Documents (concepts/)

Every new feature, bug fix, or significant change should have a concept document in the `concepts/` folder for design and planning purposes. Always check the concept regarding information. When implementing new features, make sure that a concept document exists. If none exists, always make sure to create one.
If one exists, make sure that you update it with decisions we have taken and where code related to the feature can be found.

**Always store the following in the concepts folder `concepts/` and format them `YYYY-MM-DD {title}.md`:**
- Feature concepts and design documents
- Fix summaries and root cause analyses
- Migration guides for breaking changes or major updates
- Implementation summaries

**For larger features with multiple documents, organize them in a dedicated subfolder:**
- Create a subfolder in `concepts/` with a descriptive name (e.g., `concepts/websearch-provider-api-keys/`)
- Place all related documents in that subfolder
- Include a `README.md` in the subfolder that provides an overview and links to the documents
- This keeps related documentation together and makes it easier to find

**Example naming:**
- Single document: `concepts/2026-02-02 Provider API Key Persistence Fix.md`
- Organized feature: 
  - `concepts/websearch-provider-api-keys/README.md`
  - `concepts/websearch-provider-api-keys/2026-02-03 Websearch Provider API Key Configuration.md`
  - `concepts/websearch-provider-api-keys/2026-02-03 Websearch Provider UI Screenshots.md`
  - `concepts/websearch-provider-api-keys/IMPLEMENTATION_SUMMARY_WEBSEARCH_PROVIDERS.md`

## Development Workflow

### Building and Running

```bash
# Development mode with hot reload
npm run dev

# Production build
npm run prod:build

# Start production server
npm run start:prod

# Check server health
npm run health

# View server logs
npm run logs
```

### Code Quality - CRITICAL ⚠️

**ALWAYS run linting and formatting before committing:**

```bash
# Auto-fix linting issues (REQUIRED before commits)
npm run lint:fix

# Auto-format all files (REQUIRED before commits)
npm run format:fix

# Combined command
npm run lint-format:fix
```

**Pre-commit hooks**: Husky automatically runs `lint-staged` on commit. If hooks fail:
1. Fix the reported issues
2. Stage the fixed files
3. Commit again

### Testing and Validation

**MANDATORY: Test server startup after any significant changes:**

```bash
# 1. Run linting first
npm run lint:fix

# 2. Run formatting second  
npm run format:fix

# 3. Test server startup (10 second timeout)
timeout 10s node server/server.js || echo "Server startup check completed"

# 4. Test full dev environment (15 second timeout)
timeout 15s npm run dev || echo "Development environment startup check completed"
```

This ensures:
- No linting violations
- No import/export errors
- No missing dependencies
- Server starts without runtime errors
- All modules load correctly

**Available Test Commands:**

```bash
# Adapter tests (recommended for quick validation)
npm run test:adapters

# Smoke test (adapters + health check)
npm run test:smoke

# All tests (unit, integration, e2e)
npm run test:all

# Test coverage
npm run test:coverage
```

## Code Standards and Conventions

### General Principles

1. **Preserve existing functionality** - Don't modify working code unless explicitly requested
2. **Maintain architecture** - Honor existing patterns, data flow, and file organization
3. **Minimal changes** - Make the smallest possible changes to achieve the goal
4. **Code quality first** - Always run `npm run lint:fix && npm run format:fix` before commits

### Code Style

- **ESLint 9.x**: Modern flat config (`eslint.config.js`) with comprehensive rules
- **Prettier**: Consistent formatting (`.prettierrc`)
- **ES modules**: Use `import/export` syntax throughout (not `require`)
- **No commented code**: Remove unused code rather than commenting it out
- **Error handling**: Always handle async operations properly with try/catch

### File Naming and Organization

- **React components**: PascalCase (e.g., `AppChat.jsx`, `AuthContext.jsx`)
- **Utilities**: camelCase (e.g., `authorization.js`, `configCache.js`)
- **Constants**: UPPER_SNAKE_CASE when appropriate
- **Config files**: kebab-case JSON files in `contents/config/` and `contents/apps/`

### Internationalization (i18n)

**CRITICAL**: Every user-facing string must be internationalized.

- Provide translations for at least **English (`en`)** and **German (`de`)**
- Update translation files when adding/modifying keys:
  - Built-in translations: `shared/i18n/{lang}.json`
  - Override keys: `contents/locales/{lang}.json`
- **Never assume English is the default** - respect `defaultLanguage` in `platform.json`

### Security Requirements

- **Never commit API keys** - Use environment variables in `.env` (which is gitignored)
- **Never hardcode secrets** - All sensitive data via environment variables
- **API key placeholders** - Use `YOUR_API_KEY_HERE` in examples and documentation
- **Input validation** - Validate all user input on both client and server
- **Authentication** - Use `authRequired` middleware on protected routes
- **Secret encryption at rest** - Integration secrets in `platform.json` are encrypted using `TokenStorageService` (AES-256-GCM, format: `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`). When encrypting, skip empty values, env var placeholders (`${VAR}`), and already-encrypted values. Key files: `server/services/TokenStorageService.js`, `server/routes/admin/configs.js`, `server/configCache.js`

## Repository Structure Deep Dive

### Server Architecture (`/server`)

**Core Files:**
- `server.js` - Main Express server with clustering support
- `configCache.js` - Memory-based configuration caching (hot-reload for most configs)
- `serverHelpers.js` - Shared middleware and utility functions

**Key Directories:**
- `adapters/` - LLM provider implementations (OpenAI, Anthropic, Google, Mistral)
- `services/chat/` - Chat service abstraction with streaming support
- `middleware/` - Authentication, CORS, rate limiting, error handling
- `routes/` - Modular route handlers organized by feature
- `utils/` - Server utilities (authorization, validation, helpers)
- `validators/` - Zod schemas for configuration validation

**Request Flow:**
```
Client → Express → Middleware → Route Handler → Chat Service → Adapter → LLM Provider → Streaming Response
```

### Client Architecture (`/client`)

**Organization:**
```
client/src/
├── features/          # Feature modules (apps, auth, chat, admin)
├── shared/            # Shared components and contexts
├── pages/             # Page components (UnifiedPage for dynamic content)
├── api/               # API client with caching
└── utils/             # Client utilities
```

**Key Patterns:**
- React Router for SPA routing with protected routes
- Context API for global state (AuthContext, PlatformConfigContext, UIConfigContext)
- Tailwind CSS for styling with dark/light mode support
- EventSource for LLM streaming responses

### Configuration System (`/contents`)

**Core Config Files:**
- `config/platform.json` - Server behavior, authentication, authorization
- `config/groups.json` - User groups, permissions, inheritance hierarchy
- `config/ui.json` - UI customization, pages, branding
- `config/sources.json` - Knowledge source configurations
- `config/tools.json` - Available tools and their settings
- `apps/*.json` - Individual AI application definitions (one file per app)
- `models/*.json` - Individual LLM model configurations (one file per model)

**Configuration Hot-Reload:**
- Platform/Auth changes require server restart
- Apps, Models, UI, Groups, Sources, Tools reload automatically via `configCache`

## Key Development Guidelines

### When Modifying Configuration Files

**Apps (`contents/apps/*.json`):**
- Follow Zod schema in `server/validators/appConfigSchema.js`
- Required fields: `id`, `name`, `description`, `color`, `icon`, `system`, `tokenLimit`
- Maintain localized strings for all user-facing text
- Test with multiple LLM providers if using `tools` or `outputSchema`

**Models (`contents/models/*.json`):**
- Each model is a separate JSON file (not an array)
- Required: `id`, `modelId`, `name`, `provider`, `tokenLimit`
- Set `enabled: true` to make model available
- Configure `url` for custom endpoints (e.g., local LLM providers)

**Groups (`contents/config/groups.json`):**
- Supports hierarchical inheritance via `inherits` array
- Child groups merge permissions from parents
- System validates for circular dependencies
- Standard hierarchy: `admin` → `users` → `authenticated` → `anonymous`

### When Adding New Features

1. **Server Route**: Add to appropriate subdirectory in `routes/`
2. **Client Feature**: Create feature module in `client/src/features/`
3. **Configuration**: Add to relevant JSON file in `contents/`
4. **Permissions**: Update `contents/config/groups.json` if needed
5. **Translations**: Add keys to `shared/i18n/{en,de}.json`
6. **Documentation**: Update relevant file in `docs/` (check existing docs first) and optionally create concept document in `concepts/` for design decisions
7. **Testing**: Add tests if modifying critical functionality
8. **Known Routes** ⚠️: If adding a new top-level route in `App.jsx`, update `client/src/utils/runtimeBasePath.js`

### When Adding New Routes or API Endpoints

**CRITICAL**: When adding new top-level routes to the application, you **MUST** update the `knownRoutes` array in `client/src/utils/runtimeBasePath.js`.

This array is used for base path detection to support subpath deployments (e.g., `/ihub/apps`). Without updating it:
- Subpath deployments will break
- Base path detection will fail
- Logout and navigation may redirect to wrong paths

**Example**: If you add a new route `/reports` in `App.jsx`, add `'/reports'` to the `knownRoutes` array.

**Location**: `client/src/utils/runtimeBasePath.js` - Look for the `knownRoutes` array (around line 26-37).

### When Working with Authentication

**Authentication Flow:**
1. `loadGroupsConfiguration()` - Loads and resolves group inheritance
2. `authRequired`/`authOptional` - Middleware on routes
3. `isAnonymousAccessAllowed()` - Permission check
4. `enhanceUserWithPermissions()` - Adds resolved group permissions
5. `filterResourcesByPermissions()` - Filters based on user permissions

**Auth Modes:**
- **Anonymous**: No auth required, default groups assigned
- **Local**: Username/password with JWT tokens
- **OIDC**: OpenID Connect for enterprise SSO
- **Proxy**: Header-based auth (`X-Forwarded-User`, `X-Forwarded-Groups`) + JWT

### Common Pitfalls to Avoid

❌ **Don't:**
- Modify UI layout/styles unless explicitly requested
- Change data flow between client/server without instruction
- Add, remove, or relocate UI elements without explicit direction
- Assume English is the default language
- Hardcode API keys or sensitive data
- Remove or modify working tests
- Make implicit changes to architecture

✅ **Do:**
- Run `npm run lint:fix && npm run format:fix` before commits
- Test server startup after significant changes
- Maintain existing code patterns and conventions
- Add translations for all user-facing strings (en + de minimum)
- Use environment variables for sensitive configuration
- Update code comments when modifying logic
- Preserve error handling mechanisms

## Additional Resources

- **Full Architecture**: See `CLAUDE.md` for comprehensive technical details
- **Code Guidelines**: See `LLM_GUIDELINES.md` for detailed coding rules
- **Gemini Specifics**: See `GEMINI.md` for Gemini model guidelines
- **Documentation**: Consult `docs/` for feature documentation and user guides
