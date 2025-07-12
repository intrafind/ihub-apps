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
5. **Internationalization**: All new or modified user-facing keys must have translations for English (`en`) and German (`de`). Update the appropriate JSON files under `client/src/i18n` and `contents/locales`.

## Code Modification Rules
1. **Minimal Changes**: Make only the necessary changes to implement the requested feature or fix.
2. **Documentation**: Maintain or update code comments to reflect changes.
3. **Error Handling**: Preserve or enhance existing error handling mechanisms.
4. **No Performance Degradation**: Avoid changes that could introduce performance issues.
5. **Test Impact**: Consider test implications when making changes.

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
1. **Client-Server Interaction**: Test both client and server components after changes.
2. **Model Integration**: Verify continued compatibility with all LLM providers.
3. **Error Scenarios**: Test error handling paths remain functional.

## Adaptation Requirements
These guidelines may be superseded by explicit instructions, but should be followed by default to maintain project integrity.