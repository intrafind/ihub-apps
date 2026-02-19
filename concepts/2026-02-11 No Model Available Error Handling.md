# No Model Available Error Handling - Implementation

**Date**: 2026-02-11  
**Author**: GitHub Copilot  
**Status**: Implemented

## Problem Statement

When using anonymous authentication, if no models are available to the user, the system returns an "invalid request" error because the model ID is null. This is not user-friendly and doesn't clearly indicate what the actual problem is.

## Solution Overview

Implemented comprehensive error handling for scenarios where no AI models are available to users:

1. **Server-side improvements** - Better error detection and user-friendly error messages
2. **Client-side improvements** - Visual feedback and clear error messages
3. **Internationalization** - Error messages in English and German

## Implementation Details

### 1. Server-Side Changes

#### RequestBuilder.js (`server/services/chat/RequestBuilder.js`)

Added early detection of "no models available" scenarios with specific error codes:

- **`noModelsAvailable`** - No models exist in the system at all
- **`noCompatibleModels`** - Models exist but none are compatible with the app's requirements
- **`noModelsForUser`** - Models exist but user has no permissions to access them
- **`noModelIdProvided`** - No model ID provided and no default available

**Key Changes:**
```javascript
// Check if no models are available at all
if (filteredModels.length === 0) {
  // Determine the most appropriate error message
  let errorCode = 'noCompatibleModels';
  
  if (models.length === 0) {
    errorCode = 'noModelsAvailable';
  } else if (app.allowedModels || app.tools || app.settings?.model?.filter) {
    errorCode = 'noCompatibleModels';
  } else {
    errorCode = 'noModelsForUser';
  }

  const error = new Error(...);
  error.code = errorCode;
  return { success: false, error };
}
```

Also added handling for the case where `resolvedModelId` is `undefined`:

```javascript
// Check if we still don't have a model ID
if (!resolvedModelId) {
  if (filteredModels.length > 0) {
    resolvedModelId = filteredModels[0].id;
  } else {
    const error = new Error('No model ID provided and no default model available.');
    error.code = 'noModelIdProvided';
    return { success: false, error };
  }
}
```

#### sessionRoutes.js (`server/routes/chat/sessionRoutes.js`)

Updated to return proper HTTP status codes and include error codes in responses:

```javascript
return res
  .status(
    prep.error.code === 'APP_NOT_FOUND' || prep.error.code === 'MODEL_NOT_FOUND'
      ? 404
      : prep.error.code === 'noModelsAvailable' ||
          prep.error.code === 'noCompatibleModels' ||
          prep.error.code === 'noModelIdProvided' ||
          prep.error.code === 'noModelsForUser'
        ? 400
        : 500
  )
  .json({ error: errMsg, code: prep.error.code });
```

### 2. Client-Side Changes

#### ChatInput.jsx (`client/src/features/chat/components/ChatInput.jsx`)

Added visual warning banner when no models are available:

```jsx
{/* Warning when no models are available */}
{showModelSelector && (!models || models.length === 0) && (
  <div className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
    <Icon name="exclamationTriangle" size="sm" />
    <span>{t('chat.modelSelector.noModels', 'No models available')}</span>
  </div>
)}
```

#### requestHandler.js (`client/src/api/utils/requestHandler.js`)

Enhanced error handling to extract and preserve error codes from server responses:

```javascript
enhancedError.code = error.response?.data?.code; // Extract error code from server response
```

### 3. Internationalization

#### English (`shared/i18n/en.json`)

Added error messages in the `apiErrors` section:

```json
{
  "noModelsAvailable": "No AI models are available for this app. Please contact your administrator to configure models and permissions.",
  "noCompatibleModels": "No compatible AI models found for this app. The app requires specific model features that are not available. Please contact your administrator.",
  "noModelIdProvided": "No model selected. Please select an AI model to continue.",
  "noModelsForUser": "You don't have permission to access any AI models. Please contact your administrator to request access."
}
```

Added chat section for model selector:

```json
{
  "chat": {
    "modelSelector": {
      "label": "Model",
      "choose": "Choose model",
      "noModels": "No models available",
      "loading": "Loading models..."
    }
  }
}
```

#### German (`shared/i18n/de.json`)

Added corresponding German translations:

```json
{
  "noModelsAvailable": "Für diese Anwendung sind keine KI-Modelle verfügbar. Bitte wenden Sie sich an Ihren Administrator, um Modelle und Berechtigungen zu konfigurieren.",
  "noCompatibleModels": "Keine kompatiblen KI-Modelle für diese Anwendung gefunden. Die Anwendung erfordert spezifische Modellfunktionen, die nicht verfügbar sind. Bitte wenden Sie sich an Ihren Administrator.",
  "noModelIdProvided": "Kein Modell ausgewählt. Bitte wählen Sie ein KI-Modell, um fortzufahren.",
  "noModelsForUser": "Sie haben keine Berechtigung, auf KI-Modelle zuzugreifen. Bitte wenden Sie sich an Ihren Administrator, um Zugriff anzufordern."
}
```

Added chat section:

```json
{
  "chat": {
    "modelSelector": {
      "label": "Modell",
      "choose": "Modell wählen",
      "noModels": "Keine Modelle verfügbar",
      "loading": "Modelle werden geladen..."
    }
  }
}
```

## User Experience Improvements

### Before
- Error: "Invalid request" (cryptic, unhelpful)
- No indication of what went wrong
- No guidance on how to fix the issue

### After
- Clear, specific error messages depending on the scenario
- Visual warning banner in the UI when no models are available
- Guidance to contact administrator
- Proper HTTP status codes (400 instead of 500)
- Error codes included in responses for better client-side handling

## Testing Scenarios

To test this implementation:

1. **No models in system**: Remove all models from `contents/models/` and try to use an app
   - Expected: "No AI models are available for this app" error

2. **No compatible models**: Create an app that requires `supportsTools: true` but no models have this feature
   - Expected: "No compatible AI models found for this app" error

3. **No model permissions**: Configure user groups to have empty `models` permissions array
   - Expected: "You don't have permission to access any AI models" error

4. **Anonymous user with no models**: Enable anonymous auth but give anonymous group no model permissions
   - Expected: Warning banner in UI + error message when trying to send a message

## Files Modified

### Server
- `server/services/chat/RequestBuilder.js` - Enhanced error detection and handling
- `server/routes/chat/sessionRoutes.js` - Improved HTTP status codes and error responses

### Client
- `client/src/features/chat/components/ChatInput.jsx` - Added visual warning banner
- `client/src/api/utils/requestHandler.js` - Enhanced error code extraction

### Internationalization
- `shared/i18n/en.json` - Added error messages and chat section
- `shared/i18n/de.json` - Added German translations

## Benefits

1. **Better User Experience**: Users now get clear, actionable error messages
2. **Admin Visibility**: Administrators can quickly identify configuration issues
3. **Proper Error Codes**: Client-side can handle different error scenarios appropriately
4. **Internationalization**: Error messages available in English and German
5. **Visual Feedback**: Warning banner provides immediate visual feedback in the UI

## Future Enhancements

Potential improvements for the future:

1. Add a direct link to admin panel for users with admin permissions
2. Show which specific permissions or models are missing
3. Add a "Request Access" button that sends a notification to administrators
4. Include more detailed troubleshooting information in the error messages
