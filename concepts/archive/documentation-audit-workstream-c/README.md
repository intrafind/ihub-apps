# Documentation Audit — Workstream C

**Date:** 2026-03-10
**Author:** Claude (Senior Software Engineer)
**Status:** Complete

## Purpose

Workstream C expanded five stub documentation files with accurate, source-verified content. All information was read directly from the corresponding source files before being written into the docs.

## Files Changed

| Doc file | Was | Now | Source(s) read |
| -------- | --- | --- | -------------- |
| `docs/styles.md` | ~16 lines | ~78 lines | `server/defaults/config/styles.json`, `server/services/PromptService.js` |
| `docs/prompts.md` | ~17 lines | ~130 lines | `server/validators/promptConfigSchema.js`, `contents/prompts/*.json` |
| `docs/microphone-feature.md` | ~28 lines | ~110 lines | `client/src/features/voice/hooks/useVoiceRecognition.js` |
| `docs/magic-prompt-feature.md` | ~31 lines | ~70 lines | `server/routes/magicPromptRoutes.js` |
| `docs/ui.md` | ~280 lines | ~400 lines | `server/defaults/config/ui.json` |

## Key Decisions

### styles.md
- Listed all 15 built-in style keys with their exact description strings from `styles.json`.
- Explained the `keep` sentinel: the server checks `style !== 'keep'` before appending — nothing is added to the system prompt.
- Traced the runtime flow to `PromptService.processMessageTemplates()` lines 333-346 where `configCache.getStyles()` is called and the text is appended with `'\n\n' + styles[style]`.

### prompts.md
- Fixed the critical factual error in the old stub: prompts are **individual files** in `contents/prompts/`, not a single `prompts.json`.
- Documented the full Zod schema from `promptConfigSchema.js` including variable types, predefined values, actions, and outputSchema.
- Included three real examples from the actual files: `summarize.json`, `translate-de.json`, `faq-question.json`.

### microphone-feature.md
- Added the `settings.speechRecognition` config block (service + host) which was entirely missing from the stub.
- Listed all 14 supported language mappings from the `langMap` object in `useVoiceRecognition.js`.
- Documented all voice commands (English and German) from `getCommandPatterns()`.
- Added browser compatibility notes based on Web Speech API support.
- Added Azure Speech Services configuration example.

### magic-prompt-feature.md
- Added the full API endpoint spec (POST /api/magic-prompt, request/response fields).
- Documented the 3-level model fallback chain from `magicPromptRoutes.js` lines 35-52.
- Confirmed `maxTokens: 8192` from line 66.
- Documented usage tracking fields from lines 73-81.
- Added environment variable reference table.

### ui.md
- Added `header.titleLight`, `header.titleBold`, `header.tagline` fields to the Header table (present in `ui.json` but not documented).
- Added a full `appsList.categories` section with the complete default category list, property table, and explanation of how `category` in app configs matches the IDs.
- Added `theme` section documenting all 7 light-mode color fields plus `darkMode` overrides.
- Added `pwa` section documenting all fields and instructions for enabling PWA support.

## How a Junior Can Continue

1. Check that new source files added to the codebase are reflected in the corresponding doc.
2. When new styles are added to `contents/config/styles.json`, update the table in `docs/styles.md`.
3. When new top-level fields are added to `server/validators/promptConfigSchema.js`, update the schema table in `docs/prompts.md`.
4. When new languages are added to the `langMap` in `useVoiceRecognition.js`, update the language table in `docs/microphone-feature.md`.
5. When new sections are added to `server/defaults/config/ui.json`, check if `docs/ui.md` needs a corresponding section.
