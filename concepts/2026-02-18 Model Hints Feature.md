# Model Hints Feature

Date: 2026-02-18

## Overview

The Model Hints feature allows administrators to configure important hints or warnings that are displayed to users when they select specific models in the chat interface. This is particularly useful when:

- Multiple LLMs are available with different capabilities or costs
- Certain models are being deprecated
- Models have specific usage restrictions or requirements
- Experimental or beta models need clear warnings

## Severity Levels

The feature supports four severity levels, each with distinct visual styling and behavior:

### 1. Hint (Blue)
- **Purpose**: Subtle suggestions or best practices
- **Appearance**: Blue background, non-intrusive
- **Dismissible**: Yes (optional)
- **Use Case**: "This model is optimized for quick responses. For complex reasoning tasks, consider using GPT-5."

### 2. Info (Cyan)
- **Purpose**: Important information users should know
- **Appearance**: Cyan background, noticeable
- **Dismissible**: Yes (optional)
- **Use Case**: "This model provides excellent reasoning capabilities. Recommended for complex analytical tasks."

### 3. Warning (Yellow)
- **Purpose**: Critical information that must be seen
- **Appearance**: Yellow background, prominent
- **Dismissible**: No
- **Use Case**: "This model is being deprecated and will be removed in the next release. Please migrate to Gemini 2.0 Flash."

### 4. Alert (Red)
- **Purpose**: Critical warnings requiring explicit acknowledgment
- **Appearance**: Red background, requires acknowledgment button
- **Dismissible**: No
- **Blocks Input**: Yes - users must click "I Understand" before using the model
- **Use Case**: "⚠️ EXPERIMENTAL MODEL ⚠️ This model is in early testing and may produce incorrect or unexpected results."

## Configuration

Add a `hint` object to any model configuration file:

```json
{
  "id": "model-id",
  "modelId": "provider-model-id",
  "name": {
    "en": "Model Name",
    "de": "Modellname"
  },
  "description": {
    "en": "Model description",
    "de": "Modellbeschreibung"
  },
  "hint": {
    "message": {
      "en": "This is the hint message in English",
      "de": "Dies ist die Hinweisnachricht auf Deutsch"
    },
    "level": "warning",
    "dismissible": false
  }
}
```

### Configuration Fields

- **`message`** (required): Internationalized object with hint text
  - Supports multiple languages (at minimum: `en` and `de`)
  - Can include newlines with `\n` for multi-line messages
  - Supports emojis and special characters

- **`level`** (required): Severity level
  - Options: `"hint"`, `"info"`, `"warning"`, `"alert"`

- **`dismissible`** (optional): Whether users can dismiss the hint
  - Default: `true` for `hint` and `info` levels
  - Ignored for `warning` and `alert` levels (always non-dismissible)

## Internationalization

The feature fully supports internationalization through:

1. **Hint Messages**: Defined in model configuration files per language
2. **UI Labels**: Translation keys in `shared/i18n/en.json` and `shared/i18n/de.json`:
   - `pages.appChat.modelSelector.hint.dismiss` - "Dismiss"
   - `pages.appChat.modelSelector.hint.acknowledge` - "I Understand"
   - `pages.appChat.modelSelector.hint.alertTitle` - "Important Notice"

## User Experience

### Hint and Info Levels
1. User selects a model with a hint
2. Banner appears below the model selector
3. User can read the message and optionally dismiss it
4. User can continue using the chat normally

### Warning Level
1. User selects a model with a warning
2. Yellow banner appears below the model selector
3. User cannot dismiss the banner
4. Warning is always visible when model is selected
5. User can still use the chat

### Alert Level
1. User selects a model with an alert
2. Red banner with "Important Notice" title appears
3. Chat input is disabled
4. User must click "I Understand" button to proceed
5. After acknowledgment, input is enabled
6. Acknowledgment resets when user switches to a different model

## Technical Implementation

### Files Modified

1. **`server/validators/modelConfigSchema.js`**
   - Added `hintSchema` for validation
   - Added `hint` field to model configuration schema

2. **`client/src/features/chat/components/ModelHintBanner.jsx`** (new)
   - React component for displaying hints
   - Manages dismiss and acknowledgment state
   - Implements level-specific styling

3. **`client/src/features/chat/components/ChatInput.jsx`**
   - Imports and displays ModelHintBanner
   - Manages alert acknowledgment state
   - Disables input when alert requires acknowledgment

4. **`shared/i18n/en.json`** and **`shared/i18n/de.json`**
   - Added translation keys for hint UI

### Example Models

Four example models are provided in `server/defaults/models/`:

1. **`gpt-4-turbo-hint-example.json`** - Demonstrates "hint" level
2. **`claude-3-info-example.json`** - Demonstrates "info" level
3. **`gemini-warning-example.json`** - Demonstrates "warning" level
4. **`experimental-alert-example.json`** - Demonstrates "alert" level

All examples are disabled by default (`"enabled": false`).

## Use Cases

### 1. Model Migration
When deprecating older models, use a **warning** hint to notify users:
```json
{
  "hint": {
    "message": {
      "en": "This model will be removed on March 1st. Please switch to GPT-5.",
      "de": "Dieses Modell wird am 1. März entfernt. Bitte wechseln Sie zu GPT-5."
    },
    "level": "warning"
  }
}
```

### 2. Cost Optimization
Guide users to appropriate models with **hint** level:
```json
{
  "hint": {
    "message": {
      "en": "For simple queries, GPT-4 Mini is faster and more cost-effective.",
      "de": "Für einfache Anfragen ist GPT-4 Mini schneller und kosteneffizienter."
    },
    "level": "hint",
    "dismissible": true
  }
}
```

### 3. Data Classification
Warn about sensitive data handling with **alert** level:
```json
{
  "hint": {
    "message": {
      "en": "This model processes data in a shared cloud environment. Do not use for classified or sensitive information.",
      "de": "Dieses Modell verarbeitet Daten in einer gemeinsam genutzten Cloud-Umgebung. Nicht für klassifizierte oder sensible Informationen verwenden."
    },
    "level": "alert"
  }
}
```

### 4. Experimental Features
Clearly mark beta models with **alert** level:
```json
{
  "hint": {
    "message": {
      "en": "⚠️ BETA: This model is in testing. Results may be unpredictable.",
      "de": "⚠️ BETA: Dieses Modell befindet sich im Test. Ergebnisse können unvorhersehbar sein."
    },
    "level": "alert"
  }
}
```

## Accessibility

- All hints use appropriate ARIA `role="alert"` attributes
- Color coding is supplemented with icons for colorblind users
- Alert acknowledgment is keyboard accessible
- Screen readers will announce hint content when displayed

## Future Enhancements

Potential future improvements:
- Per-user persistent acknowledgment (remember across sessions)
- Hint expiration dates (auto-remove hints after a date)
- Link support in hint messages
- Admin UI for managing hints without editing JSON
- Usage analytics (which hints are most often dismissed vs acknowledged)
