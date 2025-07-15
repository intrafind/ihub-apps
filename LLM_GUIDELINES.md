# LLM Guidelines for AI Hub Apps Project

## Core Principles

1. **Preserve Existing Functionality**: Do not modify existing functionality unless explicitly requested.
2. **Maintain Code Style**: Follow the existing code style of the project.
3. **Respect Project Architecture**: Honor the existing architecture, data flow patterns, and file organization.
4. **Explicit Over Implicit**: Make explicit changes only where instructed; avoid implicit changes.

## UI/Layout Guidelines

1. **Layout Preservation**: Do not modify UI layouts or component structure unless specifically requested.
2. **UI Element Manipulation**: Do not add, remove, or relocate UI elements without explicit instruction.
3. **Style Consistency**: Keep styles consistent with the existing Tailwind CSS implementation.
4. **Responsive Design**: Preserve responsive behavior in any UI modifications.

## Data/Configuration Guidelines

1. **Configuration Files**: When modifying configuration files (apps.json, models.json, etc.), maintain the existing schema.
2. **Data Flow**: Do not alter the flow of data between the client and server without explicit instruction.
3. **Local Storage**: Preserve the existing local storage mechanisms for user preferences and history.
4. **API Compatibility**: Maintain compatibility with the existing API structure.
5. **Internationalization**: All new or modified user-facing keys must have translations for English (`en`) and German (`de`). Update the built-in files under `shared/i18n` and any overrides in `contents/locales`.
6. **Default Language**: Never assume English is the default language. Always rely on the `defaultLanguage` value configured in the backend.

## Code Modification Rules

1. **Code Quality First**: Always run `npm run lint:fix` before making any changes or commits.
2. **Minimal Changes**: Make only the necessary changes to implement the requested feature or fix.
3. **Documentation**: Maintain or update code comments to reflect changes.
4. **Error Handling**: Preserve or enhance existing error handling mechanisms.
5. **No Performance Degradation**: Avoid changes that could introduce performance issues.
6. **Test Impact**: Consider test implications when making changes.
7. **Linting Compliance**: All code must pass ESLint and Prettier checks before committing.

## Security Considerations

1. **API Keys**: Do not expose or change handling of API keys.
2. **User Data**: Maintain protections for user data and preferences.
3. **Input Validation**: Preserve or enhance input validation.

## When Making Additions

1. **New Apps/Models**: Follow the existing schema when adding new apps or models.
2. **New Endpoints**: Follow the established pattern for creating API endpoints.
3. **New Components**: Maintain component structure and naming consistency.
4. **New Features**: Ensure new features integrate seamlessly with existing ones.

## Testing Guidelines

1. **Code Quality Checks**: Always run linting before testing:

   ```bash
   # Run linting and formatting before any testing
   npm run lint:fix
   npm run format
   ```

2. **Client-Server Interaction**: Test both client and server components after changes.
3. **Model Integration**: Verify continued compatibility with all LLM providers.
4. **Error Scenarios**: Test error handling paths remain functional.
5. **Server Startup Testing**: After every build or significant refactoring, test server startup:

   ```bash
   # MANDATORY: Run linting first
   npm run lint:fix

   # Test server startup with timeout to catch errors quickly
   timeout 10s node server/server.js || echo "Server startup check completed"

   # Test full development environment
   timeout 15s npm run dev || echo "Development environment startup check completed"
   ```

   This ensures no linting violations, import errors, missing dependencies, or runtime errors.

6. **Pre-commit Testing**: The automated pre-commit hooks will run linting on staged files. If they fail:
   - Fix the linting issues
   - Stage the fixed files
   - Commit again

## Adaptation Requirements

These guidelines may be superseded by explicit instructions, but should be followed by default to maintain project integrity.
