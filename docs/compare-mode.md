# Compare Mode

Compare Mode is a powerful feature that enables users to query two different AI models simultaneously and view their responses side-by-side. This is particularly useful for evaluating model performance, comparing response quality, or getting diverse perspectives on the same question.

## Overview

When Compare Mode is active:
- Your input is sent to **two different models** simultaneously
- Responses appear in **separate chat panels** (Model A and Model B)
- Each panel has its own **independent model selector**
- You can **scroll each panel independently** to review different parts of long responses
- Both conversations maintain **separate message histories**

## Enabling Compare Mode

Compare Mode requires configuration at two levels:

### 1. Platform-Level Configuration (Admin)

First, enable Compare Mode platform-wide:

1. Navigate to **Admin** → **Features**
2. Find the **Compare Mode** section
3. Toggle **Enable Compare Mode** to ON
4. Save changes

This makes the feature available to all apps that choose to enable it.

### 2. App-Level Configuration (Admin)

Then, enable it for specific apps:

1. Navigate to **Admin** → **Apps**
2. Select the app you want to configure
3. Scroll to the **Compare Mode** section
4. Check **Enable Compare Mode** checkbox
5. Save the app configuration

**Note**: Both platform-wide AND app-level settings must be enabled for Compare Mode to be available in an app.

## Using Compare Mode

### Activating Compare Mode

Once enabled, users can activate Compare Mode in the chat interface:

1. Open an app that has Compare Mode enabled
2. Click the **Compare Mode** toggle button in the header (next to "New Chat" and "Edit App")
3. The interface switches to side-by-side layout

### Selecting Models

When Compare Mode is active:

1. **Model A** (left panel): Select a model using the dropdown in the left panel header
2. **Model B** (right panel): Select a different model using the dropdown in the right panel header

You can choose any combination of available models, including:
- The same model with different settings
- Different models from the same provider
- Models from different providers (e.g., OpenAI vs Anthropic)

### Sending Messages

1. Type your message in the input field at the bottom
2. Press **Enter** or click **Send**
3. Your message is sent to **both models simultaneously**
4. Responses stream into their respective panels as they arrive

### Managing Messages

Each panel has full message management capabilities:

- **Resend**: Click the resend icon on any message to resend it (only in that panel)
- **Edit**: Modify and resend messages
- **Delete**: Remove messages from the conversation
- **Scroll**: Each panel scrolls independently for easy comparison

### Clearing Chat

Click the **New Chat** button (trash icon) in the header to:
- Clear both chat panels
- Reset conversation history for both models
- Start fresh with new model selections

### Deactivating Compare Mode

Click the **Compare Mode** toggle button again to:
- Return to standard single-model chat
- Keep your conversation history from the main chat
- Hide the compare mode interface

## Use Cases

### Model Evaluation
Compare different models to see which performs better for your specific task:
```
Model A: GPT-4 Turbo
Model B: Claude 3.5 Sonnet
```

### Quality Assurance
Verify response consistency across different models:
```
Model A: Primary production model
Model B: Backup/alternative model
```

### Cost vs Performance
Compare expensive high-quality models against faster cheaper alternatives:
```
Model A: GPT-4 (high cost, high quality)
Model B: GPT-3.5 Turbo (lower cost, faster)
```

### Creative Variations
Get diverse perspectives or creative variations:
```
Model A: Model configured for creative writing
Model B: Model configured for technical accuracy
```

## Configuration Reference

### Platform Configuration

In `contents/config/platform.json`:

```json
{
  "features": {
    "compareMode": {
      "enabled": true
    }
  }
}
```

### App Configuration

In `contents/apps/your-app.json`:

```json
{
  "id": "your-app",
  "name": { "en": "Your App" },
  "description": { "en": "An app with compare mode" },
  "features": {
    "compareMode": {
      "enabled": true
    }
  }
}
```

**Default Behavior**: If the `compareMode.enabled` field is not specified, it defaults to `true` (enabled) when the platform feature is enabled.

To explicitly disable Compare Mode for an app:

```json
{
  "features": {
    "compareMode": {
      "enabled": false
    }
  }
}
```

## Technical Details

### Chat Isolation

Each panel in Compare Mode maintains:
- **Separate chat history**: Messages in Model A don't appear in Model B and vice versa
- **Independent chat IDs**: Each panel has its own unique chat session identifier
- **Isolated streaming**: Responses stream independently without interference
- **Separate thought processes**: Extended thinking features remain isolated per model

### Performance Considerations

- **Simultaneous requests**: Both models process your input at the same time
- **Independent streaming**: Each model streams its response as it generates it
- **No blocking**: Slower models don't delay faster models
- **Resource usage**: Uses approximately twice the resources of single-model chat

### Limitations

- **Model availability**: You can only select from models you have permission to use
- **Token limits**: Each model respects its own token limits independently
- **File uploads**: Uploaded files are sent to both models
- **Chat history**: Enabling "Keep Chat History" affects both panels
- **Canvas mode**: Compare Mode is not available when Canvas mode is active

## Troubleshooting

### Compare Mode Toggle Not Visible

**Causes**:
- Platform-level feature not enabled
- App-level setting not enabled
- User doesn't have permission to access the app

**Solution**:
1. Verify platform feature is enabled in Admin → Features
2. Verify app has Compare Mode enabled in Admin → Apps → [App Name]
3. Check user permissions for the app

### Only One Model Selector Visible

This is expected behavior. When Compare Mode is active:
- The bottom model selector (in chat input) is hidden
- Two model selectors appear in the panel headers (one for each model)

### Cannot Scroll Messages

If scrolling doesn't work:
1. Try clicking inside the panel to focus it
2. Check if you have long messages that exceed viewport height
3. Refresh the page if the issue persists

### Resend Not Working

Ensure you're clicking the resend button in the correct panel:
- Left panel resend → resends in Model A
- Right panel resend → resends in Model B

### Server Blocking or Errors

If you see errors like "Unsupported URL scheme":
1. Verify all selected models are properly configured
2. Check that model IDs in the configuration match actual model endpoints
3. Review server logs for detailed error messages

## Best Practices

1. **Choose Complementary Models**: Select models with different strengths for more valuable comparisons
2. **Clear Between Topics**: Use "New Chat" when switching to a new topic to avoid confusion
3. **Review Both Responses**: Don't just pick the first response - compare both for quality
4. **Save Useful Comparisons**: Export or copy valuable comparative results for future reference
5. **Mind Resource Usage**: Remember that Compare Mode uses more API credits/tokens

## See Also

- [App Configuration Guide](apps.md) - General app configuration
- [Models](models.md) - Model configuration and management
- [User Guide](user-guide.md) - Basic user interface overview
