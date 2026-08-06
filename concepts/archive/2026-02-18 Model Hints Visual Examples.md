# Model Hints Visual Examples

This document shows visual representations of how model hints appear in the UI.

## 1. Hint Level (Blue - Subtle)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chat Input                                                     │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Type your message here...                                 │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║ ℹ️  This model is optimized for quick responses. For     ║ │
│  ║    complex reasoning tasks, consider using GPT-5.    [×] ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│  │ Background: Light Blue / Dark Blue                          │
│  │ Icon: Information Circle                                    │
│  │ Dismissible: Yes                                            │
│                                                                 │
│  [+] [GPT-4 Turbo ▼]                                    [Send] │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Info Level (Cyan - Noticeable)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chat Input                                                     │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Type your message here...                                 │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║ ℹ️  This model provides excellent reasoning capabilities.║ │
│  ║    Recommended for complex analytical tasks.         [×] ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│  │ Background: Light Cyan / Dark Cyan                          │
│  │ Icon: Information Circle                                    │
│  │ Dismissible: Yes                                            │
│                                                                 │
│  [+] [Claude 3 Opus ▼]                                  [Send] │
└─────────────────────────────────────────────────────────────────┘
```

## 3. Warning Level (Yellow - Prominent)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chat Input                                                     │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Type your message here...                                 │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║ ⚠️  This model is being deprecated and will be removed   ║ │
│  ║    in the next release. Please migrate to Gemini 2.0     ║ │
│  ║    Flash.                                                 ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│  │ Background: Light Yellow / Dark Yellow                      │
│  │ Icon: Exclamation Triangle                                  │
│  │ Dismissible: No (always visible)                            │
│                                                                 │
│  [+] [Gemini Pro ▼]                                     [Send] │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Alert Level (Red - Requires Acknowledgment)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chat Input                                                     │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Type your message here... (DISABLED)                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│  │ Note: Input is DISABLED until user acknowledges alert      │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║ ⚠️  Important Notice                                      ║ │
│  ║                                                            ║ │
│  ║ ⚠️ EXPERIMENTAL MODEL ⚠️                                  ║ │
│  ║                                                            ║ │
│  ║ This model is in early testing and may produce incorrect  ║ │
│  ║ or unexpected results. Only use for testing purposes.     ║ │
│  ║ Do not use for production data or sensitive information.  ║ │
│  ║                                                            ║ │
│  ║                                        [I Understand] ◄─  ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│  │ Background: Light Red / Dark Red                            │
│  │ Icon: Exclamation Triangle                                  │
│  │ Dismissible: No                                             │
│  │ Requires: Click "I Understand" button to enable input      │
│                                                                 │
│  [+] [Experimental Model ▼]                             [Send] │
│                                                         (disabled)│
└─────────────────────────────────────────────────────────────────┘
```

## UI Component Structure

```
ModelHintBanner Component
├── Container (rounded, bordered, padding, colored background)
│   ├── Icon (left, appropriate to level)
│   ├── Content (center, flex-1)
│   │   ├── Title (for alert level: "Important Notice")
│   │   └── Message (localized, supports multiline)
│   └── Actions (right)
│       ├── Dismiss Button (×) - for hint/info levels
│       └── Acknowledge Button - for alert level
│
└── State Management
    ├── isDismissed (for dismissible hints)
    ├── isAcknowledged (for alert level)
    └── Auto-reset on model change
```

## Color Schemes

### Light Mode
- **Hint**: Blue 50 background, Blue 800 text, Blue 600 icon
- **Info**: Cyan 50 background, Cyan 800 text, Cyan 600 icon
- **Warning**: Yellow 50 background, Yellow 800 text, Yellow 600 icon
- **Alert**: Red 50 background, Red 800 text, Red 600 icon

### Dark Mode
- **Hint**: Blue 900/20 background, Blue 300 text, Blue 400 icon
- **Info**: Cyan 900/20 background, Cyan 300 text, Cyan 400 icon
- **Warning**: Yellow 900/20 background, Yellow 300 text, Yellow 400 icon
- **Alert**: Red 900/20 background, Red 300 text, Red 400 icon

## User Flow Examples

### Flow 1: Dismissible Hint
1. User selects "GPT-4 Turbo (Hint Example)" model
2. Blue hint banner appears below model selector
3. User reads: "This model is optimized for quick responses..."
4. User clicks [×] to dismiss
5. Banner disappears
6. User can immediately use chat input

### Flow 2: Non-dismissible Warning
1. User selects "Gemini Pro (Warning Example)" model
2. Yellow warning banner appears
3. User reads: "This model is being deprecated..."
4. User cannot dismiss the warning
5. Warning remains visible while model is selected
6. User can still use chat input
7. If user switches to different model, warning disappears

### Flow 3: Alert with Acknowledgment
1. User selects "Experimental Model (Alert Example)" model
2. Red alert banner appears with "Important Notice" title
3. Chat input is DISABLED (grayed out)
4. User reads: "⚠️ EXPERIMENTAL MODEL ⚠️..."
5. User must click [I Understand] button
6. After clicking, alert remains visible but input is enabled
7. User can now use chat input
8. If user switches to different model and back, must acknowledge again

## Integration Points

```
AppChat.jsx
  └─> ChatInput.jsx
        ├─> ModelSelector (user picks model)
        ├─> ModelHintBanner (conditionally rendered)
        │     └─> Shows hint if selectedModel has hint property
        └─> Textarea (disabled if alert requires acknowledgment)
```

## Accessibility Features

- `role="alert"` on banner for screen readers
- Icons provide visual distinction (not color-only)
- Keyboard navigation supported
- Button focus states clear
- Clear hierarchy with title for alerts
- Sufficient color contrast ratios
- Multi-line text wrapping for long messages

## Configuration Example (Complete)

```json
{
  "id": "secure-model",
  "modelId": "secure-llm-v1",
  "name": {
    "en": "Secure Enterprise Model",
    "de": "Sicheres Unternehmensmodell"
  },
  "description": {
    "en": "Secure on-premises model for sensitive data",
    "de": "Sicheres On-Premises-Modell für sensible Daten"
  },
  "url": "https://internal.company.com/v1/chat",
  "provider": "local",
  "tokenLimit": 16384,
  "enabled": true,
  "hint": {
    "message": {
      "en": "🔒 This model processes data within your secure network. All data stays on-premises and is not sent to external providers.",
      "de": "🔒 Dieses Modell verarbeitet Daten in Ihrem sicheren Netzwerk. Alle Daten bleiben On-Premises und werden nicht an externe Anbieter gesendet."
    },
    "level": "info",
    "dismissible": true
  }
}
```

## Best Practices

1. **Keep messages concise** - Users should understand quickly
2. **Use appropriate level** - Don't overuse alerts
3. **Provide context** - Explain why the hint matters
4. **Include alternatives** - Suggest better options when applicable
5. **Localize properly** - Ensure translations are accurate
6. **Test readability** - Check in both light and dark modes
7. **Consider accessibility** - Ensure screen readers work well
