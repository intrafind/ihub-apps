# Fix for Social Media App Share Link Issue

**Date:** 2026-02-10  
**Issue:** Generated Link for Social Media App does not work  
**Status:** ✅ Fixed

## Problem Description

When users shared messages from the social media app, the generated links contained variables without the `var_` prefix, causing them to be ignored when the link was opened.

**Example problematic URL:**
```
/apps/social-media?prefill=&send=true&count=1&post_type=posts+related+to+trending+topics&platform=LinkedIn&topic=Image+Generation+for+Marketing&tone=Use+an+inspirational+and+motivational+tone.&additional_instructions=
```

When this link was opened, the app variables (count, post_type, platform, etc.) were not populated because `AppChat.jsx` expects variables with the `var_` prefix (e.g., `var_count`, `var_post_type`).

## Root Cause Analysis

The issue was in `client/src/features/chat/components/ChatMessage.jsx` at line 176.

When generating share links for messages, the code was adding variables directly without the `var_` prefix:

```javascript
// BEFORE (incorrect):
if (variables && Object.keys(variables).length > 0) {
  Object.entries(variables).forEach(([key, value]) => {
    params.set(key, value);  // ❌ Missing var_ prefix
  });
}
```

However, `AppChat.jsx` parsing logic expects variables WITH the `var_` prefix:

```javascript
// AppChat.jsx parsing (unchanged):
searchParams.forEach((value, key) => {
  if (key.startsWith('var_')) {
    newVars[key.slice(4)] = value;
    changed = true;
  }
});
```

## Solution

Fixed `ChatMessage.jsx` to add the `var_` prefix when creating share link parameters:

```javascript
// AFTER (correct):
if (variables && Object.keys(variables).length > 0) {
  Object.entries(variables).forEach(([key, value]) => {
    params.set(`var_${key}`, value);  // ✅ Added var_ prefix
  });
}
```

## Implementation Details

### Files Modified

1. **`client/src/features/chat/components/ChatMessage.jsx`** (Line 176)
   - Changed: `params.set(key, value)` 
   - To: `params.set(\`var_\${key}\`, value)`

2. **`client/src/features/apps/pages/AppChat.jsx`**
   - Reverted to original state (removed workaround that accepted both formats)
   - Maintains standard parsing logic that expects `var_` prefix

### Why This Approach?

This fix addresses the **root cause** rather than working around the symptom:

- ✅ **Consistency**: All link generation now uses the `var_` prefix standard
- ✅ **Simplicity**: Single source of truth for URL parameter format
- ✅ **Maintainability**: No need to support multiple URL formats
- ✅ **Performance**: No additional validation logic needed in parsing

## Comparison: Before vs After

### Before Fix

**Share modal** (AppChat.jsx line 1409):
```javascript
...Object.fromEntries(Object.entries(variables).map(([k, v]) => [`var_${k}`, v]))
// ✅ Correct - uses var_ prefix
```

**Share message** (ChatMessage.jsx line 176):
```javascript
params.set(key, value);
// ❌ Incorrect - missing var_ prefix
```

**Result:** Inconsistent behavior - share modal links worked, share message links didn't.

### After Fix

**Share modal** (AppChat.jsx line 1409):
```javascript
...Object.fromEntries(Object.entries(variables).map(([k, v]) => [`var_${k}`, v]))
// ✅ Correct - uses var_ prefix
```

**Share message** (ChatMessage.jsx line 176):
```javascript
params.set(`var_${key}`, value);
// ✅ Correct - uses var_ prefix
```

**Result:** Consistent behavior - both share methods now work correctly.

## Testing

### Test Case: Social Media App Variables

Input variables:
```javascript
{
  count: '1',
  post_type: 'posts related to trending topics',
  platform: 'LinkedIn',
  topic: 'Image Generation for Marketing',
  tone: 'Use an inspirational and motivational tone.',
  additional_instructions: ''
}
```

Generated URL (after fix):
```
?prefill=&send=true&var_count=1&var_post_type=posts+related+to+trending+topics&var_platform=LinkedIn&var_topic=Image+Generation+for+Marketing&var_tone=Use+an+inspirational+and+motivational+tone.&var_additional_instructions=
```

Verification:
- ✅ All variables use `var_` prefix
- ✅ AppChat.jsx correctly parses all variables
- ✅ Form fields are populated when link is opened
- ✅ No direct variable names present in URL

### Quality Checks

- ✅ Server startup successful
- ✅ ESLint passed (no errors)
- ✅ Prettier formatting applied
- ✅ Backward compatibility maintained
- ✅ Consistent with existing share modal behavior

## Impact Assessment

### Positive Impacts

1. **Bug Fixed**: Share message links now work correctly
2. **Consistency**: All link generation uses the same format
3. **Maintainability**: Single standard to maintain
4. **User Experience**: Shared links work as expected

### No Breaking Changes

- The fix only affects newly generated share links
- Existing bookmarks or saved links are unaffected
- No changes to the URL parsing logic
- No changes to the share modal functionality

## Code Location

**File:** `client/src/features/chat/components/ChatMessage.jsx`  
**Function:** `handleShareMessage`  
**Line:** 176 (approximately)

```javascript
const handleShareMessage = () => {
  // ... code omitted ...
  
  // Add variables if they exist
  const variables = message.meta?.variables || message.variables;
  if (variables && Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([key, value]) => {
      params.set(`var_${key}`, value);  // ← THE FIX
    });
  }
  
  // ... code omitted ...
};
```

## Related Components

### Share Modal (Already Correct)

The share modal in `AppChat.jsx` was already generating links correctly with the `var_` prefix. This fix brings the "share message" functionality in line with the existing share modal behavior.

### URL Parsing (Unchanged)

The URL parsing logic in `AppChat.jsx` remains unchanged and continues to expect the `var_` prefix for all variable parameters.

## Conclusion

This fix resolves the reported issue by correcting the link generation to use the standard `var_` prefix format, ensuring consistency across all share functionality and maintaining compatibility with the existing URL parsing logic.

The solution is minimal, focused, and addresses the root cause rather than working around the symptom.
