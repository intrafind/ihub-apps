# Model Hints Examples

This directory contains example model configurations demonstrating the **Model Hints** feature, which allows displaying important, internationalized messages when users select specific models.

## Feature Overview

The Model Hints feature enables administrators to show contextual warnings, information, or alerts based on:
- Cost optimization guidance
- Model deprecation notices
- Data classification requirements
- Experimental model warnings

## Hint Severity Levels

The feature supports four severity levels with different behaviors:

### 1. Hint (Blue) - `hint`
**Purpose**: Subtle, non-intrusive suggestions  
**Behavior**: Dismissible by user, input remains enabled  
**Example File**: `gpt-4-turbo-hint-example.json`

```json
"hint": {
  "message": {
    "en": "This model is optimized for quick responses. For complex reasoning tasks, consider using GPT-5.",
    "de": "Dieses Modell ist für schnelle Antworten optimiert. Für komplexe Denkaufgaben sollten Sie GPT-5 in Betracht ziehen."
  },
  "level": "hint",
  "dismissible": true
}
```

### 2. Info (Cyan) - `info`
**Purpose**: Noticeable information  
**Behavior**: Dismissible by user, input remains enabled  
**Example File**: `claude-3-info-example.json`

```json
"hint": {
  "message": {
    "en": "This model provides excellent reasoning capabilities. Recommended for complex analytical tasks.",
    "de": "Dieses Modell bietet hervorragende Reasoning-Fähigkeiten. Empfohlen für komplexe analytische Aufgaben."
  },
  "level": "info",
  "dismissible": true
}
```

### 3. Warning (Yellow) - `warning`
**Purpose**: Critical information that must be seen  
**Behavior**: Always visible (non-dismissible), input remains enabled  
**Example File**: `gemini-warning-example.json`

```json
"hint": {
  "message": {
    "en": "This model is being deprecated and will be removed in the next release. Please migrate to Gemini 2.0 Flash.",
    "de": "Dieses Modell wird eingestellt und in der nächsten Version entfernt. Bitte migrieren Sie zu Gemini 2.0 Flash."
  },
  "level": "warning",
  "dismissible": false
}
```

### 4. Alert (Red) - `alert`
**Purpose**: Critical warnings requiring explicit acknowledgment  
**Behavior**: Input disabled until user clicks "I Understand" button  
**Example File**: `experimental-alert-example.json`

```json
"hint": {
  "message": {
    "en": "⚠️ EXPERIMENTAL MODEL ⚠️\n\nThis model is in early testing and may produce incorrect or unexpected results. Only use for testing purposes. Do not use for production data or sensitive information.",
    "de": "⚠️ EXPERIMENTELLES MODELL ⚠️\n\nDieses Modell befindet sich in der frühen Testphase und kann falsche oder unerwartete Ergebnisse liefern. Nur für Testzwecke verwenden. Nicht für Produktionsdaten oder sensible Informationen verwenden."
  },
  "level": "alert",
  "dismissible": false
}
```

## Using These Examples

### Step 1: Copy to Your Models Directory

Copy the example file you want to use to your `contents/models/` directory:

```bash
cp examples/models/experimental-alert-example.json contents/models/
```

### Step 2: Customize the Configuration

Edit the copied file to match your needs:
- Change the `id` and `modelId` to match your actual model
- Update the `name` and `description`
- Customize the hint `message` for your use case
- Adjust the hint `level` as appropriate
- Set `enabled: true` to make the model available

### Step 3: Restart or Hot-Reload

Model configurations with hints are hot-reloadable - no server restart needed. The hint will appear immediately when users select the model.

## Example Files Included

| File | Level | Use Case |
|------|-------|----------|
| `gpt-4-turbo-hint-example.json` | hint | Cost optimization suggestion |
| `claude-3-info-example.json` | info | Model capability information |
| `gemini-warning-example.json` | warning | Deprecation notice |
| `experimental-alert-example.json` | alert | Experimental model warning |

## Configuration Schema

The hint configuration must follow this schema:

```json
{
  "hint": {
    "message": {
      "en": "English message (required)",
      "de": "German message (required)",
      // Add more languages as needed
    },
    "level": "hint" | "info" | "warning" | "alert",  // Required
    "dismissible": true | false  // Optional, defaults based on level
  }
}
```

**Required Fields**:
- `message`: Object with localized strings (minimum: `en` and `de`)
- `level`: One of the four severity levels

**Optional Fields**:
- `dismissible`: Whether user can dismiss the hint (only applies to hint/info levels)

## Common Use Cases

### Model Deprecation
```json
"hint": {
  "message": {
    "en": "This model will be removed on March 1st. Please migrate to the new version.",
    "de": "Dieses Modell wird am 1. März entfernt. Bitte migrieren Sie zur neuen Version."
  },
  "level": "warning"
}
```

### Cost Optimization
```json
"hint": {
  "message": {
    "en": "For simple queries, use GPT-4 Mini for 10x cost savings.",
    "de": "Für einfache Anfragen verwenden Sie GPT-4 Mini für 10-fache Kosteneinsparungen."
  },
  "level": "hint",
  "dismissible": true
}
```

### Data Classification
```json
"hint": {
  "message": {
    "en": "⚠️ This model uses external cloud services. Do not use for classified information.",
    "de": "⚠️ Dieses Modell verwendet externe Cloud-Dienste. Nicht für klassifizierte Informationen verwenden."
  },
  "level": "alert"
}
```

### Experimental Features
```json
"hint": {
  "message": {
    "en": "🧪 BETA: This model includes experimental features that may change without notice.",
    "de": "🧪 BETA: Dieses Modell enthält experimentelle Funktionen, die sich ohne Vorankündigung ändern können."
  },
  "level": "warning"
}
```

## Internationalization

All hint messages must be internationalized:
- **Minimum**: Provide English (`en`) and German (`de`) translations
- **Additional**: Add more language codes as needed (e.g., `fr`, `es`, `ja`)
- **Fallback**: System falls back to English if user's language is not available

### UI Element Translations

The hint feature includes built-in UI elements that are automatically translated:
- **"Important Notice"** (Alert title) - Displayed for alert-level hints
- **"Dismiss"** (Dismiss button) - Shown for dismissible hints (hint/info levels)
- **"I Understand"** (Acknowledge button) - Required for alert-level hints

These UI elements are automatically translated based on the user's language preference. You only need to provide translations for the hint `message` content in your model configuration files.

## Visual Examples

See detailed visual examples with color schemes and behavior:
- `concepts/2026-02-18 Model Hints Visual Examples.md`

## Testing

See comprehensive testing guide:
- `concepts/2026-02-18 Model Hints Testing Guide.md`

## Documentation

Complete feature documentation available:
- `concepts/2026-02-18 Model Hints Feature.md` - Full feature guide
- `concepts/IMPLEMENTATION_SUMMARY_MODEL_HINTS.md` - Technical implementation

## Support

For questions or issues with the Model Hints feature:
1. Review the concept documents in `/concepts/`
2. Check the schema in `server/validators/modelConfigSchema.js`
3. Refer to these example files for working configurations
