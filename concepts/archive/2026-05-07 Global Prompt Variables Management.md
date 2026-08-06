# Global Prompt Variables Management Feature

**Date**: 2026-05-07
**Status**: Implemented (Updated based on PR feedback)
**Related Issue**: #1137
**PR**: [Link to PR]

## Update (Post-PR Feedback)

Based on feedback from @manzke, the implementation was refactored:

1. **Integration with Prompts Database**: Prompt variables are now part of the AdminPromptsPage as a dedicated "Variables" tab, rather than a standalone page
2. **Accessible Without Feature Flag**: The variables functionality works even when the `promptsLibrary` feature is disabled
3. **Tab Navigation**: AdminPromptsPage now has two tabs:
   - **Prompts Tab**: Requires `promptsLibrary` feature (hidden when disabled)
   - **Variables Tab**: Always accessible regardless of feature flags
4. **Smart Defaults**: When `promptsLibrary` is disabled, the page automatically shows the Variables tab as default
5. **URL State Persistence**: Tab selection is preserved in URL query parameter (`?tab=prompts` or `?tab=variables`)

**Files Changed in Refactor**:
- **Removed**: `client/src/features/admin/pages/AdminPromptVariablesPage.jsx` (standalone page no longer needed)
- **Modified**: `client/src/features/admin/pages/AdminPromptsPage.jsx` (added tab navigation and Variables tab)
- **Modified**: `client/src/App.jsx` (removed standalone route, made prompts route always accessible)
- **Modified**: `client/src/features/admin/pages/AdminHome.jsx` (updated to show "Prompts & Variables" as single entry)

**Commits**:
- Initial implementation: 8b0d696, 0e60480, 9592ef8
- Integration refactor: 0e7edb2, bf5c3c5

## Overview

This feature allows platform administrators to create and manage custom global prompt variables that can be used across all apps, system prompts, and user prompts in iHub Apps. Previously, only built-in variables (like `{{date}}`, `{{user_name}}`, etc.) were available. With this enhancement, administrators can now define organization-specific variables (e.g., `{{company}}`, `{{department}}`, `{{support_email}}`) through a dedicated admin UI.

## Problem Statement

Prior to this implementation:
1. **Limited Customization**: Only built-in system variables were available
2. **No Reusability**: Organization-specific information had to be hardcoded in each app's system prompt
3. **Maintenance Burden**: Updating common information required editing multiple app configurations
4. **No Discoverability**: Admins were unaware of available variables and how to use them

The user specifically requested:
> "We should have a place to create and manage global variables, which are replaced. A place in the admin, where I can configure for example a variable "company" and add context to it. This would allow to setup the description of my company once and reuse it in prompts with {{company}}."

## Solution Design

### Architecture

The solution extends the existing `globalPromptVariables` structure in `platform.json` to support custom variables alongside the existing `context` field:

```json
{
  "globalPromptVariables": {
    "context": "Current date: {{date}}. Company: {{company}}.",
    "variables": {
      "company": "IntraFind Software AG",
      "department": "AI Solutions",
      "support_email": "support@intrafind.de"
    }
  }
}
```

### Components

#### Backend Changes

1. **Schema Extension** (`server/defaults/config/platform.json`)
   - Added `variables` object to `globalPromptVariables`
   - Backward compatible - existing configurations continue to work

2. **PromptService Enhancement** (`server/services/PromptService.js`)
   - Modified `resolveGlobalPromptVariables()` to merge custom variables with built-in ones
   - Built-in variables take precedence to prevent accidental override
   - Custom variables are available in all prompt contexts

3. **Migration Script** (`server/migrations/V034__add_global_prompt_variables_custom_variables.js`)
   - Automatically adds empty `variables` object to existing installations
   - Handles both scenarios: existing `globalPromptVariables` and missing configuration

#### Frontend Changes

1. **GlobalPromptVariablesEditor Component** (`client/src/features/admin/components/GlobalPromptVariablesEditor.jsx`)
   - UI for managing custom variables
   - Display of all built-in variables with descriptions
   - Add/edit/delete custom variables
   - Real-time validation of variable keys
   - Copy-to-clipboard functionality for easy use

2. **AdminPromptVariablesPage** (`client/src/features/admin/pages/AdminPromptVariablesPage.jsx`)
   - Dedicated admin page for variable management
   - Integration with platform config API
   - Change tracking and save functionality

3. **Navigation Integration**
   - Added link in Admin Home page
   - Route configuration in App.jsx
   - Accessible at `/admin/prompt-variables`

### Key Features

**Built-in Variables (unchanged)**:
- `{{year}}`, `{{month}}`, `{{date}}`, `{{time}}`, `{{day_of_week}}`
- `{{timezone}}`, `{{locale}}`
- `{{user_name}}`, `{{user_email}}`
- `{{model_name}}`, `{{tone}}`, `{{location}}`
- `{{platform_context}}`

**Custom Variables (new)**:
- Admin-defined key-value pairs
- Used anywhere built-in variables are supported
- Managed through dedicated UI
- Validated naming rules (alphanumeric + underscores, must start with letter/underscore)
- Built-in variables take precedence

**Variable Naming Rules**:
- Must start with a letter or underscore
- Can contain letters, numbers, and underscores only
- Cannot use names reserved for built-in variables
- Case-sensitive

**Usage Locations**:
1. Global context string (`globalPromptVariables.context`)
2. App system prompts (`app.system`)
3. App prompt templates (`app.prompt`)
4. iAssistant configurations
5. Any other prompt template

## Implementation Details

### Variable Resolution Flow

1. **Request Received**: User sends a message through an app
2. **Context Loading**: PromptService loads platform configuration
3. **Built-in Variable Resolution**: System variables populated from user profile, session, and system state
4. **Custom Variable Merging**: Custom variables from `globalPromptVariables.variables` added to the variable map
5. **Precedence Handling**: Built-in variables override custom ones with the same name
6. **Context Processing**: Global context string processed with all available variables
7. **Prompt Assembly**: App system prompts receive the complete variable set
8. **LLM Request**: Final prompt sent to the LLM with all variables resolved

### Data Flow

```
platform.json
  └─> globalPromptVariables.variables
      └─> PromptService.resolveGlobalPromptVariables()
          ├─> Built-in variables (priority)
          └─> Custom variables (fallback)
              └─> Available in all prompts via {{variable_name}}
```

### Security Considerations

1. **Input Validation**: Variable keys validated with regex pattern
2. **No Code Injection**: Variables are simple string replacements
3. **Admin Access Only**: Variable management requires admin authentication
4. **Built-in Protection**: System variables cannot be overridden

## Files Modified

### Backend
- `server/defaults/config/platform.json` - Added `variables` field
- `server/services/PromptService.js` - Enhanced variable resolution
- `server/migrations/V034__add_global_prompt_variables_custom_variables.js` - Migration script

### Frontend (Initial Implementation)
- `client/src/features/admin/components/GlobalPromptVariablesEditor.jsx` - New component for managing variables
- ~~`client/src/features/admin/pages/AdminPromptVariablesPage.jsx`~~ - **Removed** (replaced by tab integration)
- `client/src/features/admin/pages/AdminPromptsPage.jsx` - **Updated** with tab navigation and Variables tab
- `client/src/features/admin/pages/AdminHome.jsx` - **Updated** navigation link
- `client/src/App.jsx` - **Updated** routing (removed standalone route, made prompts route always accessible)

### Documentation
- `docs/platform.md` - Comprehensive custom variables documentation
- `concepts/2026-05-07 Global Prompt Variables Management.md` - This document

## Usage Examples

### Example 1: Company Information

**Configuration**:
```json
{
  "globalPromptVariables": {
    "context": "You work for {{company}}. Contact: {{support_email}}.",
    "variables": {
      "company": "IntraFind Software AG",
      "support_email": "support@intrafind.de"
    }
  }
}
```

**App System Prompt**:
```json
{
  "system": {
    "en": "You are a helpful assistant for {{company}}. When users need help, direct them to {{support_email}}."
  }
}
```

**Result**: Both `{{company}}` and `{{support_email}}` are replaced in the final prompt sent to the LLM.

### Example 2: Department-Specific Bot

**Configuration**:
```json
{
  "globalPromptVariables": {
    "variables": {
      "department": "Customer Success",
      "team_lead": "Jane Smith",
      "escalation_process": "Contact @oncall in Slack for urgent issues"
    }
  }
}
```

**Usage in App**:
The variables can be referenced in any app's system prompt, greeting, or prompt templates.

## Testing Approach

### Manual Testing Steps

1. Navigate to `/admin/prompt-variables`
2. Add a new variable: `company` = `"Test Company"`
3. Add another variable: `department` = `"Engineering"`
4. Verify variables appear in the UI
5. Copy variable syntax to clipboard
6. Edit an app's system prompt to include `{{company}}`
7. Send a message through the app
8. Verify the variable is replaced in the LLM request (check debug logs or response)

### Automated Testing

The PromptService variable resolution can be tested with:
```javascript
const resolvedVars = PromptService.resolveGlobalPromptVariables(user, modelName, lang, style);
// Verify custom variables are present
assert(resolvedVars.company === 'IntraFind Software AG');
// Verify built-in variables still work
assert(resolvedVars.date !== undefined);
```

## Migration Strategy

**Existing Installations**:
- Migration V034 runs automatically on server startup
- Adds empty `variables: {}` object if missing
- No breaking changes - all existing functionality preserved

**New Installations**:
- Default `platform.json` includes empty `variables` object
- Admins can immediately start adding custom variables

## Backward Compatibility

- ✅ Configurations without `variables` field continue to work
- ✅ Built-in variables unchanged
- ✅ Existing apps require no modification
- ✅ Migration handles both scenarios (existing config and missing config)

## Future Enhancements

Potential future improvements:
1. **Variable Picker Widget**: Dropdown in text editors showing available variables
2. **Multi-language Support**: Different values per language
3. **Computed Variables**: Variables that reference other variables
4. **Variable Templates**: Pre-defined variable sets for common use cases
5. **Import/Export**: Bulk import/export of variables
6. **Variable Validation**: Type hints and validation rules for variable values

## Known Limitations

1. **Simple String Replacement**: Variables are basic string substitutions, not template expressions
2. **No Nested Variables**: Cannot reference one variable from another during definition
3. **Case Sensitive**: `{{Company}}` and `{{company}}` are different
4. **Admin UI Only**: No API endpoint for programmatic variable management (yet)

## Success Metrics

Feature is successful if:
1. Admins can create custom variables without reading code
2. Variables work consistently across all prompt contexts
3. No performance degradation in prompt processing
4. Migration completes successfully on all existing installations
5. Documentation is clear and actionable

## Conclusion

This feature successfully addresses the original request by providing a centralized, user-friendly way to manage organization-specific prompt variables. The implementation is backward compatible, well-documented, and follows existing iHub Apps architectural patterns.
