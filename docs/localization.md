# Localization

This document describes how server-side translations are loaded and how customers can override individual keys.

## Built-in Locale Files

Default translations are stored in the repository under the `shared/i18n/` directory. These files are included in the application bundle. Example:

```text
shared/i18n/en.json
shared/i18n/de.json
```

## Override Locale Files

Customers can override any of the built-in strings by creating files in `contents/locales/`. Only the keys that should be changed need to be present. For example, to change the application title in German:

```json
{
  "app": {
    "title": "Meine iHub Apps"
  }
}
```

Save this as `contents/locales/de.json`. During startup the server merges these overrides with the built-in locales.

## Merge Behaviour

1. The server loads the built-in file from `shared/i18n/{lang}.json`.
2. If an override file exists in `contents/locales/{lang}.json` it is loaded and merged into the base file.
3. When merging, keys from the override file replace the built-in values.
4. If the override contains keys that do not exist in the built-in file a warning is printed.

## Fetching Translations

Translations are served via the `/api/translations/:lang` endpoint. The language code must match one of the built-in locale files (e.g. `en` or `de`). Overrides are applied automatically.

## Client-side Language Detection

The client picks its UI language in this priority order (`client/src/services/i18nService.js`):

1. **`?language=de` URL parameter** — applied by `Layout.jsx` via `updateSettingsFromUrl()` (see `client/src/utils/integrationSettings.js`). The value is also persisted to `localStorage` under `ihubIntegrationSettings`.
2. **`localStorage.i18nextLng`** — the user's last explicit choice (e.g. via the language selector). Persists across reloads.
3. **`navigator.language`** — the browser's UI language. Used on the very first visit, when no localStorage value exists yet.
4. **`defaultLanguage`** from `contents/config/ui.json` (server-provided) — used as the final fallback.

### Iframe Embedding

When iHub is embedded in an iframe, the browser's `navigator.language` is forwarded into the iframe, so first-time visitors will see the browser's preferred language automatically. After that, the language stored in `localStorage.i18nextLng` wins on subsequent loads — even if the browser language changes — because that value represents a deliberate choice.

To force a language from the embedding page, you have two options:

**1. URL parameter (load-time):**

```html
<iframe src="https://ihub.example.com/?language=de"></iframe>
```

**2. `postMessage` (runtime, overwrites localStorage):**

The parent window can send a `postMessage` to the iframe at any time. The iframe listens for messages of type `ihub:setLanguage` and changes the UI language immediately. The new language is persisted to `localStorage.i18nextLng`, so it survives reloads.

```javascript
// In the parent page
const iframe = document.getElementById('ihub-iframe');
iframe.contentWindow.postMessage(
  { type: 'ihub:setLanguage', language: 'de' },
  'https://ihub.example.com'
);
```

The iframe responds with an acknowledgement once the change is applied:

```javascript
window.addEventListener('message', event => {
  if (event.data?.type === 'ihub:languageChanged') {
    console.log('iHub now in', event.data.language);
  }
});
```

**Accepted language codes** follow the BCP 47 basic form: `en`, `de`, `en-US`, `pt-BR`. Invalid values are ignored with a console warning. Anything other than the `ihub:setLanguage` message type is ignored, so the listener is safe to leave in place even on pages that exchange other postMessage traffic.
