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
    "title": "Meine AI Hub Apps"
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

