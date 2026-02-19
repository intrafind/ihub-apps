# Gemini Guidelines for iHub Apps Project

This document provides guidelines for Gemini models working on the iHub Apps project.

## Core Principles

1.  **Preserve Existing Functionality**: Do not modify existing functionality unless explicitly requested.
2.  **Maintain Code Style**: Follow the existing code style of the project.
3.  **Respect Project Architecture**: Honor the existing architecture, data flow patterns, and file organization.
4.  **Explicit Over Implicit**: Make explicit changes only where instructed; avoid implicit changes.

## UI/Layout Guidelines

1.  **Layout Preservation**: Do not modify UI layouts or component structure unless specifically requested.
2.  **UI Element Manipulation**: Do not add, remove, or relocate UI elements without explicit instruction.
3.  **Style Consistency**: Keep styles consistent with the existing Tailwind CSS implementation.
4.  **Responsive Design**: Preserve responsive behavior in any UI modifications.

## Data/Configuration Guidelines

1.  **Configuration Files**: When modifying configuration files (apps.json, models.json, etc.), maintain the existing schema.
2.  **Data Flow**: Do not alter the flow of data between the client and server without explicit instruction.
3.  **Local Storage**: Preserve the existing local storage mechanisms for user preferences and history.
4.  **API Compatibility**: Maintain compatibility with the existing API structure.
5.  **Internationalization**: All new or modified user-facing keys must have translations for English (`en`) and German (`de`). Update the built-in files under `shared/i18n` and any overrides in `contents/locales`.
6.  **Default Language**: Never assume English is the default language. Always rely on the `defaultLanguage` value configured in the backend.

## Code Modification Rules

1.  **Code Quality First**: Always run `npm run lint:fix` before making any changes or commits.
2.  **Minimal Changes**: Make only the necessary changes to implement the requested feature or fix.
3.  **Documentation**: Maintain or update code comments to reflect changes.
4.  **Error Handling**: Preserve or enhance existing error handling mechanisms.
5.  **No Performance Degradation**: Avoid changes that could introduce performance issues.
6.  **Test Impact**: Consider test implications when making changes.
7.  **Linting Compliance**: All code must pass ESLint and Prettier checks before committing.

## Security Considerations

1.  **API Keys**: Do not expose or change handling of API keys.
2.  **User Data**: Maintain protections for user data and preferences.
3.  **Input Validation**: Preserve or enhance input validation.

## When Making Additions

1.  **New Apps/Models**: Follow the existing schema when adding new apps or models.
2.  **New Endpoints**: Follow the established pattern for creating API endpoints.
3.  **New Components**: Maintain component structure and naming consistency.
4.  **New Features**: Ensure new features integrate seamlessly with existing ones.
5.  **New Routes** ⚠️: When adding new top-level routes, update `client/src/utils/runtimeBasePath.js`

### Adding New Routes - CRITICAL

When adding new top-level routes to `client/src/App.jsx`, you **MUST** update the `knownRoutes` array in `client/src/utils/runtimeBasePath.js`.

**Why this matters**:

- Enables correct base path detection for subpath deployments (e.g., `/ihub/apps`)
- Prevents incorrect redirects during logout
- Ensures assets load from correct paths

**Steps**:

1. Add route in `App.jsx`: `<Route path="newroute" element={...} />`
2. Add to `knownRoutes` array: `'/newroute'`
3. Test both root and subpath deployments

**Current routes**: `/apps`, `/admin`, `/auth`, `/login`, `/chat`, `/pages`, `/prompts`, `/settings`, `/teams`, `/s`

## Testing Guidelines

1.  **Code Quality Checks**: Always run linting before testing:

    ```bash
    # Run linting and formatting before any testing
    npm run lint:fix
    npm run format:fix
    ```

2.  **Client-Server Interaction**: Test both client and server components after changes.
3.  **Model Integration**: Verify continued compatibility with all LLM providers.
4.  **Error Scenarios**: Test error handling paths remain functional.
5.  **Server Startup Testing**: After every build or significant refactoring, test server startup:

    ```bash
    # MANDATORY: Run linting first
    npm run lint:fix

    # MANDATORY: Run formatting second
    npm run format:fix

    # Test server startup with timeout to catch errors quickly
    timeout 10s node server/server.js || echo "Server startup check completed"

    # Test full development environment
    timeout 15s npm run dev || echo "Development environment startup check completed"
    ```

    This ensures no linting violations, import errors, missing dependencies, or runtime errors.

6.  **Pre-commit Testing**: The automated pre-commit hooks will run linting on staged files. If they fail:
    - Fix the linting issues
    - Stage the fixed files
    - Commit again

## Adaptation Requirements

These guidelines may be superseded by explicit instructions, but should be followed by default to maintain project integrity.

## Documentation Organization

### Feature Documentation

All feature documentation should be added to the `docs/` folder:

**When to Update Existing Documentation:**

- **Always check first** if documentation already exists in `docs/` for the area you're working on
- Update existing files rather than creating new ones when the feature fits within an existing document
- For example, new model features should be added to `docs/models.md`, new UI features to `docs/ui.md`, etc.

**When to Create New Documentation:**

- Only create new documentation files when the feature doesn't fit into any existing document
- Use descriptive, lowercase filenames with hyphens: `feature-name.md`
- Add the new file to `docs/SUMMARY.md` for inclusion in the documentation site

**Documentation Structure:**

- `docs/` - User-facing feature documentation, guides, and references
  - Updated as features are added or modified
  - Organized by topic (models, authentication, configuration, etc.)
  - Rendered on the documentation site

**Example Workflow:**

1. Check if `docs/models.md`, `docs/ui.md`, or other relevant file exists
2. If exists, add your feature documentation to the appropriate section
3. If doesn't exist, create new file and add to `docs/SUMMARY.md`
4. Use clear headings, code examples, and use cases

### Concept Documents (Design & Planning)

The `concepts/` folder is for design documents, RFC-style proposals, and technical planning:

**Single Document Features:**

- Format: `concepts/YYYY-MM-DD {title}.md`
- Example: `2026-02-02 Provider API Key Persistence Fix.md`

**Multi-Document Features (3+ related documents):**

- Create subfolder: `concepts/{feature-name}/`
- Include `README.md` with overview
- Place all related documents in subfolder
- Example:
  ```
  concepts/websearch-provider-api-keys/
  ├── README.md
  ├── 2026-02-03 Websearch Provider API Key Configuration.md
  └── IMPLEMENTATION_SUMMARY_WEBSEARCH_PROVIDERS.md
  ```

**Documentation Types:**

- Feature concepts and design documents
- Fix summaries and root cause analyses
- Migration guides
- Implementation summaries
- UI/UX documentation with screenshots
