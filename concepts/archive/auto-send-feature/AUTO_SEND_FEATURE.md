# Auto-Send Feature Documentation

## Overview

The auto-send feature allows URLs to automatically submit a prefilled message when the page loads. This is useful for creating direct links to support bots or other AI assistants where you want the conversation to start immediately.

## Usage

Add both `prefill` and `send=true` query parameters to the URL:

```
https://ihub.local.intrafind.io/apps/platform?prefill=Welche%20quellen%20kennst%20du?&send=true
```

### Query Parameters

- **prefill**: The message to prefill in the chat input (URL encoded)
- **send**: Set to `true` to automatically send the prefilled message

## Implementation Details

### Location

- File: `client/src/features/apps/pages/AppChat.jsx`

### How it works

1. The component reads both `prefill` and `send` query parameters on load
2. The prefilled message is set in the input field as before
3. If `send=true` is present:
   - The component waits for the app to be fully loaded
   - It checks that there's a prefill message and the app is not currently processing
   - It removes the `send` parameter from the URL to prevent re-triggering
   - After a 100ms delay (to ensure everything is initialized), it dispatches a form submit event
   - The message is sent automatically

### Safety Features

- **Single execution**: Uses a `useRef` to ensure auto-send only triggers once per page load
- **App change handling**: Resets the trigger when switching to a different app
- **Validation**: Only sends if all conditions are met:
  - `send=true` parameter present
  - Prefill message exists
  - App is loaded
  - Not currently processing a message
  - Form reference is available

### URL Cleanup

The `send` parameter is automatically removed from the URL after triggering to:

- Keep the URL clean
- Prevent re-triggering if the user refreshes the page
- Match the existing behavior for other query parameters like `model`, `style`, etc.

## Examples

### Simple question

```
/apps/support-bot?prefill=How%20do%20I%20reset%20my%20password?&send=true
```

### With additional parameters

```
/apps/analyzer?prefill=Analyze%20this%20data&send=true&model=gpt-4&temp=0.7
```

### Multiple variables

```
/apps/report-generator?prefill=Generate%20report&send=true&var_date=2024-01-01&var_format=PDF
```

## Testing

To test the feature:

1. Start the development server: `npm run dev`
2. Open a URL with both `prefill` and `send=true` parameters
3. Verify that:
   - The message appears in the input field
   - The message is automatically sent
   - The `send` parameter is removed from the URL
   - The AI responds to the message

## Troubleshooting

### Message doesn't send automatically

Check that:

- Both `prefill` and `send=true` are present in the URL
- The prefill parameter is not empty
- The app has finished loading
- There's no other message currently being processed

### Message sends multiple times

This should not happen due to the `autoSendTriggered` ref guard. If it does:

- Check the browser console for errors
- Verify that the ref is being reset correctly when needed
