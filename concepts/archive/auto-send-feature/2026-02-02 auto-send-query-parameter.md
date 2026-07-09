# Auto-Send Query Parameter Feature

## Overview

Enables automatic message submission when users visit a URL with both a prefilled message and a `send=true` query parameter. This feature is designed to streamline support workflows by allowing staff to create direct links that immediately start conversations with AI assistants.

## Business Context

Support staff often receive questions that the iHub support bot can answer. Previously, staff could share links with the `prefill` parameter to pre-populate the question, but users still had to manually click send. This extra step creates friction and reduces the likelihood that users will engage with the bot.

## User Story

As a support staff member, I want to share a link that automatically starts a conversation with the bot, so that users get immediate answers without having to manually send the message.

## Implementation

### URL Format

```
https://ihub.local.intrafind.io/apps/[app-id]?prefill=[message]&send=true
```

### Example URLs

```
# Simple question
/apps/platform?prefill=Welche%20quellen%20kennst%20du?&send=true

# With additional parameters
/apps/support?prefill=How%20to%20reset%20password?&send=true&model=gpt-4

# With variables
/apps/analyzer?prefill=Analyze&send=true&var_date=2024-01-01
```

### Technical Details

**Location**: `client/src/features/apps/pages/AppChat.jsx`

**Components Modified**:
1. Added `autoSendTriggered` ref to track execution state
2. Added useEffect to reset trigger when app changes
3. Added useEffect to handle auto-send logic
4. Added `send` to query parameter cleanup list

**Auto-Send Logic Flow**:
1. Component reads `send` query parameter on load
2. Checks all preconditions:
   - `send=true` is present
   - Not already triggered
   - Prefill message exists
   - App is loaded
   - Not currently processing
3. Marks as triggered (prevents re-execution)
4. Removes `send` from URL (prevents refresh re-trigger)
5. Waits 100ms for initialization
6. Dispatches form submit event

**Safety Mechanisms**:
- **Single execution guard**: `autoSendTriggered` ref prevents multiple sends
- **App change handling**: Ref resets when switching apps
- **Comprehensive validation**: Multiple checks before triggering
- **URL cleanup**: Parameter removed after use

**Query Parameter Cleanup**:
The `send` parameter is added to the existing cleanup list alongside `model`, `style`, `outfmt`, `temp`, `history`, `prefill`, and variable parameters. This ensures consistent behavior where all configuration parameters are removed from the URL after being processed.

## Code Changes

### Files Modified

1. **client/src/features/apps/pages/AppChat.jsx**
   - Line ~248: Added `autoSendTriggered` ref declaration
   - Line ~250-253: Added useEffect to reset trigger on app change
   - Line ~255-273: Added useEffect for auto-send logic
   - Line ~199: Added `send` to cleanup parameter list

### Dependencies

The implementation relies on:
- React hooks: `useRef`, `useEffect`
- React Router: `useSearchParams`, `useNavigate`
- Existing `formRef` for form submission
- Existing `prefillMessage` from query parameters
- Existing `processing` state from useAppChat hook

## Testing

### Manual Testing Steps

1. Start development server: `npm run dev`
2. Navigate to app with parameters: `/apps/[app-id]?prefill=Test%20message&send=true`
3. Verify:
   - Message appears in input field
   - Message is automatically sent
   - `send` parameter removed from URL
   - AI responds appropriately

### Edge Cases

1. **Empty prefill**: Auto-send does not trigger
2. **App still loading**: Waits for app to be ready
3. **Currently processing**: Waits for processing to complete
4. **Page refresh**: Does not re-send (parameter removed from URL)
5. **App switch**: Trigger resets, allowing new auto-send

## Future Enhancements

Potential improvements:
- Add loading indicator during auto-send delay
- Support for multiple sequential messages
- Configurable delay time via query parameter
- Analytics tracking for auto-sent messages
- Error handling and retry logic

## Related Issues

- Original issue: Automatic sending of messages
- Related feature: `prefill` query parameter (existing)

## Decisions Made

1. **Trigger mechanism**: Chose form event dispatch over direct function call
   - Reason: Maintains existing validation and event flow
   
2. **Delay timing**: 100ms delay before submission
   - Reason: Ensures DOM and React state are fully initialized
   
3. **Parameter cleanup**: Remove `send` from URL after use
   - Reason: Prevents re-trigger on refresh, keeps URL clean
   
4. **Single execution**: Use ref instead of state
   - Reason: Ref doesn't cause re-renders, simpler logic

5. **Reset on app change**: Clear trigger when appId changes
   - Reason: Allows auto-send to work again when switching apps

## Maintenance Notes

- Auto-send logic is tightly coupled to form submission mechanism
- Changes to form handling may require updates to auto-send
- The 100ms delay is arbitrary and may need adjustment
- Consider monitoring for race conditions in production
