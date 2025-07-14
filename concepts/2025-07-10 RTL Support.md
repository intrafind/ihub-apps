# RTL Support

## Overview
Adds support for right-to-left languages by loading Arabic translations and adjusting the document direction automatically.

## Key Files
- `client/src/hooks/useLanguageDirection.js` – sets `document.dir` based on the active language.
- `client/src/i18n/core/ar.json` and `contents/locales/ar.json` – Arabic translation files.
- `server/routes/chat/dataRoutes.js` – includes `ar` in the list of supported languages.

## Testing
Follow the steps in [docs/rtl-support.md](../docs/rtl-support.md) to verify the interface renders correctly in Arabic.
