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

**2. `BroadcastChannel` (runtime, cross-product):**

iHub publishes and listens on a same-origin [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) named `intrafind`. The channel is shared with other IntraFind products (iFinder, iAssistant, …), so changing the language anywhere keeps every product in sync.

Event shape:

```javascript
{ type: 'language-changed', language: '<locale>' }
```

The `type` field is **unprefixed** because the channel name already provides the namespace; future cross-product events will use the same channel and discriminate via `type`.

Behaviour:

- **iHub publishes** `language-changed` whenever its UI language changes (URL parameter, the in-app selector, or an inbound channel message).
- **iHub listens** for `language-changed` and switches its UI to the requested locale, persisting it to `localStorage.i18nextLng`.
- An inbound change does not bounce back onto the channel, so two products cannot loop on each other.
- BroadcastChannel is **same-origin by design**, so cross-origin host pages must reach iHub through the same domain — for example, by exposing iHub at `/ihub` behind a reverse proxy that also serves the host application.

Parent / sibling product example:

```javascript
// Send (host page or another IntraFind product on the same origin)
const channel = new BroadcastChannel('intrafind');
channel.postMessage({ type: 'language-changed', language: 'de' });

// Listen for changes from iHub or any other product on the channel
channel.addEventListener('message', event => {
  if (event.data?.type === 'language-changed') {
    console.log('IntraFind UI language is now', event.data.language);
  }
});
```

**Accepted language codes** follow the BCP 47 basic form: `en`, `de`, `en-US`, `pt-BR`. Invalid values are ignored with a console warning. Messages with any other `type` are passed through silently, so unrelated cross-product events on the same channel will not affect the language.
