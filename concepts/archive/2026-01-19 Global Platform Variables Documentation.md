# Global Platform Variables Documentation

## Date
2026-01-19

## Overview
This document tracks the comprehensive documentation effort for the `globalPromptVariables` feature in the iHub Apps platform. The goal was to create clear, actionable documentation for administrators to understand how to configure and use global variables across their AI applications.

## Problem Statement
The `globalPromptVariables` feature in `platform.json` was implemented but not adequately documented. Administrators needed comprehensive guidance on:
- What global prompt variables are and how they work
- How to configure them in `platform.json`
- What built-in variables are available
- How to use variables in app configurations
- Best practices and use cases
- Troubleshooting common issues

## Solution

### Documentation Structure
Expanded the `globalPromptVariables` section in `/docs/platform.md` to include:

1. **Feature Overview** - Clear explanation of what global prompt variables do
2. **Configuration** - Example configuration with explanation
3. **Built-in Variables Table** - Comprehensive list of all available variables
4. **How It Works** - Step-by-step explanation of variable resolution
5. **Use Cases** - 5 practical examples for common scenarios
6. **App Integration Examples** - How to use variables in app configs
7. **Best Practices** - Guidelines for effective usage
8. **Variable Priority** - Precedence rules when variables overlap
9. **Advanced Configuration** - Complex examples
10. **Troubleshooting** - Common issues and solutions

### Built-in Variables Documented

| Category | Variables |
|----------|-----------|
| **Date/Time** | `year`, `month`, `date`, `time`, `day_of_week` |
| **Localization** | `timezone`, `locale` |
| **User Info** | `user_name`, `user_email`, `location` |
| **System** | `model_name`, `tone`, `platform_context` |

### Key Findings from Code Analysis

**Implementation Location:**
- Primary logic: `/server/services/PromptService.js`
- Method: `resolveGlobalPromptVariables()`
- Processing: `processMessageTemplates()`

**Variable Resolution Process:**
1. System reads `globalPromptVariables.context` from `platform.json`
2. Built-in variables are populated from user session, profile, and system state
3. Variables in the context string are replaced with actual values
4. Processed context becomes available as `{{platform_context}}`
5. All variables are available in app prompts automatically

**Variable Sources:**
- **Date/Time**: Generated from `new Date()` with user's timezone
- **User Info**: From authenticated user object or empty for anonymous
- **Locale**: From user preference or platform `defaultLanguage`
- **Model**: From current inference request
- **Timezone**: User profile setting or defaults to UTC

**Integration Points:**
- Apps can use `{{platform_context}}` in system prompts
- All variables work in app `prompt` templates
- Variables are combined with app-specific variables (app variables take precedence)

### Real-World Examples Found

The codebase shows `{{platform_context}}` being used in:
- `/examples/apps/deep-researcher.json` - Injects global context at start of system prompt
- Default `platform.json` - Standard configuration for date/timezone awareness

## Use Cases Documented

1. **Date and Time Awareness** - Keep AI current with real-time date/time
2. **Personalization** - User-specific context in all interactions
3. **Localization Support** - Language and timezone-appropriate responses
4. **Knowledge Cutoff Awareness** - Help AI acknowledge training data limitations
5. **Compliance and Auditing** - Enterprise tracking requirements

## Best Practices Documented

1. Keep context concise to preserve token budget
2. Use only relevant variables for your use case
3. Be mindful of privacy when including user information
4. Test across different user scenarios (authenticated, anonymous, timezones)
5. Leverage locale-aware formatting for dates/times
6. Plan for empty fallback values for anonymous users

## Configuration Examples

### Minimal Configuration
```json
{
  "globalPromptVariables": {
    "context": "Date: {{date}} | TZ: {{timezone}} | Lang: {{locale}}"
  }
}
```

### Comprehensive Configuration
```json
{
  "globalPromptVariables": {
    "context": "IMPORTANT CONTEXT:\n- Current date: {{date}} ({{day_of_week}})\n- Time: {{time}} in {{timezone}}\n- User: {{user_name}}\n- Language: {{locale}}\n- Model: {{model_name}}\n\nWhen users ask about 'today', 'now', 'latest', or 'recent' information, remember that your knowledge may be outdated."
  }
}
```

## Technical Implementation Notes

**Variable Resolution (from PromptService.js):**
```javascript
const globalPromptVars = {
  year: now.getFullYear().toString(),
  month: (now.getMonth() + 1).toString().padStart(2, '0'),
  date: dateFormatter.format(now),
  time: timeFormatter.format(now),
  day_of_week: now.toLocaleDateString(language || defaultLang, { ...tzOptions, weekday: 'long' }),
  timezone: timezone,
  locale: language || platformConfig.defaultLanguage || 'en',
  user_name: user?.name || user?.displayName || '',
  user_email: user?.email || '',
  model_name: modelName || '',
  tone: style || '',
  location: user?.location || user?.settings?.location || ''
};
```

**Processing Flow:**
1. Context string loaded from `platform.json`
2. Variables replaced in context string
3. Result stored as `platform_context` variable
4. All variables (including `platform_context`) available in prompts
5. App-specific variables merged (with precedence over global vars)
6. Final prompt sent to AI model

## Files Modified

- `/docs/platform.md` - Added comprehensive `globalPromptVariables` documentation

## Files Created

- `/concepts/2026-01-19 Global Platform Variables Documentation.md` - This concept document

## Testing Recommendations

1. **Variable Resolution Testing**
   - Test with authenticated user
   - Test with anonymous user
   - Test with different timezones
   - Test with different locales

2. **App Integration Testing**
   - Create test app using global variables
   - Verify `{{platform_context}}` works in system prompts
   - Verify individual variables work in prompt templates
   - Test variable precedence (app vars override global vars)

3. **Edge Cases**
   - Empty user fields (anonymous)
   - Missing timezone (should default to UTC)
   - Missing locale (should use defaultLanguage)
   - Long context strings (token budget impact)

## Documentation Quality Checklist

- [x] Clear explanation of what the feature does
- [x] Configuration examples provided
- [x] All built-in variables documented with examples
- [x] Multiple use cases demonstrated
- [x] Best practices included
- [x] Troubleshooting section added
- [x] Integration examples for apps
- [x] Variable priority/precedence explained
- [x] Privacy considerations mentioned
- [x] Token efficiency considerations noted

## Future Enhancements

Potential improvements to consider:

1. **Custom Variables** - Allow admins to define custom global variables beyond built-in ones
2. **Conditional Context** - Apply different contexts based on user groups or apps
3. **Variable Functions** - Support computed variables (e.g., `{{date+7}}` for week ahead)
4. **Environment Variables** - Allow referencing environment variables in context
5. **Variable Validation** - Warn about undefined variables in admin UI
6. **Variable Preview** - Admin UI showing resolved variable values

## Related Documentation

- `/docs/apps.md` - App configuration guide (references prompt variables)
- `/docs/platform.md` - Platform configuration (main documentation location)
- `/server/services/PromptService.js` - Implementation details
- `/examples/apps/deep-researcher.json` - Real usage example

## Stakeholder Impact

**For Platform Administrators:**
- Complete reference for configuring global variables
- Understand what's possible with the feature
- Best practices to avoid common pitfalls
- Troubleshooting guide for issues

**For App Developers:**
- Know what variables are available
- Understand how to use them in apps
- Examples to copy and adapt
- Variable precedence rules

**For End Users:**
- More contextually aware AI responses
- Personalized interactions
- Accurate date/time handling
- Better localization support

## Success Metrics

Documentation is successful if administrators can:
1. Configure `globalPromptVariables` without assistance
2. Understand all available built-in variables
3. Choose appropriate variables for their use case
4. Troubleshoot variable resolution issues
5. Create effective global contexts for their organization

## References

- Issue: "Document the global platform variables"
- Implementation: `server/services/PromptService.js` (lines 14-93, 124-213)
- Config Schema: `server/defaults/config/platform.json` (lines 5-7)
- Example Usage: `examples/apps/deep-researcher.json` (lines 14-15)
