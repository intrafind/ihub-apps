# Auto-Send Feature - Quick Reference

## What It Does

Allows URLs to automatically send prefilled messages without requiring the user to click the send button.

## Before This Feature

```
User Flow (OLD):
1. Support staff shares: /apps/bot?prefill=How%20to%20reset%20password?
2. User clicks link
3. User sees message in input field
4. User must click SEND button ← Extra step!
5. Bot responds
```

## After This Feature

```
User Flow (NEW):
1. Support staff shares: /apps/bot?prefill=How%20to%20reset%20password?&send=true
2. User clicks link
3. Message automatically sent ← No extra step!
4. Bot responds immediately
```

## Quick Start

### Basic Usage
```
OLD URL: /apps/platform?prefill=Your%20question
NEW URL: /apps/platform?prefill=Your%20question&send=true
                                                 ^^^^^^^^^^^^
                                                 Add this!
```

### Real Example
```
Question: "Welche quellen kennst du?"

URL: https://ihub.local.intrafind.io/apps/platform?prefill=Welche%20quellen%20kennst%20du?&send=true
```

## Benefits

✅ **Better User Experience**
- No manual action required
- Immediate response
- Reduces friction

✅ **Better for Support**
- Send users direct answers
- Reduce support tickets
- Faster resolution

✅ **Fully Backwards Compatible**
- Old URLs still work
- New parameter is optional
- No breaking changes

## Technical Details

**Modified Files**: 1
- `client/src/features/apps/pages/AppChat.jsx`

**Lines Changed**: 28 lines added

**Testing**: All checks pass ✅

## Safety Features

1. ✅ Only sends once (no loops)
2. ✅ Validates message exists
3. ✅ Waits for app to load
4. ✅ Cleans up URL after send
5. ✅ Handles app switching

## When To Use

Use `send=true` when you want:
- Direct support links
- Pre-answered FAQs
- Automated workflows
- Quick access to common questions

Don't use `send=true` when:
- User should review before sending
- Message needs user modification
- Interactive selection required

## Browser Compatibility

Works in all browsers that support:
- URL parameters
- React
- EventSource (existing requirement)

No additional dependencies or requirements.

## Summary

**One parameter addition = Instant answers**

Before: `?prefill=question`
After:  `?prefill=question&send=true`

That's it! 🎉
