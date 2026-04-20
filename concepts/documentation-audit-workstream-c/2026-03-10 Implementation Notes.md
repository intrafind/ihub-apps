# Workstream C — Implementation Notes

**Date:** 2026-03-10

## Source File Findings

### styles.json (`server/defaults/config/styles.json`)
There are exactly 16 entries in the file. One of them (`keep`) is a sentinel that instructs the server to leave the system prompt alone. The other 15 are real style instructions. The file is flat — keys are style identifiers, values are English instruction strings. One entry (`einfache, leichte Sprache`) is a German-language style with a lengthy B1 plain-language rewriting ruleset.

### PromptService.js (`server/services/PromptService.js`, lines 333-346)
The style is applied in `processMessageTemplates()`:

```javascript
if (style) {
  let styles = configCache.getStyles();
  if (styles && styles[style] && style !== 'keep') {
    systemPrompt += `\n\n${styles[style]}`;
  }
}
```

Key observations:
- Style is only applied when a `system` message is being constructed (i.e., when `app` is provided and no system message already exists in `messages`).
- `configCache.getStyles()` is used — no disk read at request time.
- The text is appended after sources, skills injection, and outputFormat instructions.

### promptConfigSchema.js (`server/validators/promptConfigSchema.js`)
The schema uses Zod with `.strict()` on all sub-objects, meaning unknown keys are rejected. Required fields are `id`, `name`, `description`, `prompt`. All other fields are optional. The `variables[].type` enum is: `string | number | boolean | select | textarea`.

### useVoiceRecognition.js (`client/src/features/voice/hooks/useVoiceRecognition.js`)
The `langMap` object on lines 153-168 maps 14 two-letter codes to BCP 47 locales. The service selection on lines 138-146 switches between `AzureSpeechRecognition` (custom class) and the browser's `SpeechRecognition`. The microphone mode (`automatic` vs `manual`) maps directly to `recognition.continuous` (false vs true).

### magicPromptRoutes.js (`server/routes/magicPromptRoutes.js`)
- Endpoint: `POST /api/magic-prompt` (wrapped by `buildServerPath()` for subpath deployments)
- Auth: `authRequired` middleware — always requires login
- Validation: `magicPromptSchema` Zod validator
- `maxTokens: 8192` — hardcoded on line 66, not configurable per-request
- The 3-level fallback: `modelId (request) → config.MAGIC_PROMPT_MODEL → models[0].id`
- Usage is tracked via `recordMagicPrompt()` from `usageTracker.js`

### ui.json (`server/defaults/config/ui.json`)
Sections present in the file that were missing from docs:
- `header.titleLight` / `header.titleBold` / `header.tagline` — splits the brand name into two weights
- `appsList.categories` — full category list with 7 defaults (all, coding, writing, business, analysis, communication, utility)
- `promptsList.categories` — parallel structure for the prompts library
- `theme` — 7 light-mode colors + `darkMode` overrides
- `pwa` — disabled by default, full manifest metadata

## Assumptions Made

1. `disallowStyleSelection` under `settings` — this was inferred from the app config schema pattern, not directly verified in the PromptService. The docs note this as a setting to disable the UI selector.
2. `custom` speech recognition service — the source code shows `case 'custom':` falls through to `default:` which uses the browser API. Documented as "reserved for future custom providers."
3. The PWA `display` options listed (`standalone`, `fullscreen`, `minimal-ui`, `browser`) follow the Web App Manifest spec, not a source file enum — the source only has `"standalone"` as the default value.
