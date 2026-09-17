# Customizing iHub Apps

This guide explains how to customize iHub Apps — labels, translations, branding,
apps, models, styles, and pages — **without ever editing the files that ship with
the application**.

## The Golden Rule: only edit the `contents/` folder

iHub Apps separates **shipped defaults** from **customer customizations**:

| Location                      | Purpose                                                | Edit it?                    |
| ----------------------------- | ------------------------------------------------------ | --------------------------- |
| `shared/i18n/{lang}.json`     | Built-in UI translations that ship with the app        | ❌ **Never** — upgrades overwrite it |
| `server/defaults/**`          | Default config templates copied on first run           | ❌ **Never**                |
| `contents/**`                 | Your customizations (config, locales, apps, pages …)   | ✅ **Yes — edit only here** |

Everything you change lives under `contents/`. This keeps your customizations
separate from the codebase so they:

- survive application upgrades,
- can be version-controlled or mounted as a volume independently,
- never cause merge conflicts with the shipped `shared/` and `server/` files.

> If you ever find yourself editing a file under `shared/` or `server/`, stop —
> there is an override mechanism under `contents/` for it instead.

---

## Overriding Labels & Translations

All user-facing UI text (buttons, menus, labels, messages) comes from locale
files. The defaults ship in `shared/i18n/en.json`, `shared/i18n/de.json`, etc.
**Do not edit those.** Instead, create an override file in `contents/locales/`.

### How it works

1. The server loads the built-in file from `shared/i18n/{lang}.json`.
2. If `contents/locales/{lang}.json` exists, it is **deep-merged** on top of the base.
3. Keys present in your override **replace** the built-in values; everything else
   falls back to the shipped default.
4. Overrides apply to **both** the server and the client UI, because the client
   fetches merged translations from the `/api/translations/:lang` endpoint.

You only need to include the keys you want to change — not the whole file.

### Step-by-step

1. **Find the key you want to change.** Open the built-in file (e.g.
   `shared/i18n/en.json`) and locate the key path — for example the app title
   lives at `app.title`. *(Read it for reference only; do not edit it.)*

2. **Create the override file** `contents/locales/en.json` containing only that
   key, preserving its nesting:

   ```json
   {
     "app": {
       "title": "Acme AI Workspace"
     }
   }
   ```

3. **Repeat per language.** To also change the German title, create
   `contents/locales/de.json`:

   ```json
   {
     "app": {
       "title": "Acme KI-Arbeitsplatz"
     }
   }
   ```

4. **Reload.** Locale overrides are picked up automatically by the config cache —
   no server restart is required. Refresh the browser to see the change.

### Overriding multiple / nested keys

The merge is recursive, so you can override deeply nested keys while leaving
their siblings untouched:

```json
{
  "app": {
    "title": "Acme AI Workspace",
    "subtitle": "Intelligent solutions for your business"
  },
  "chat": {
    "placeholder": "Ask me anything about your business..."
  }
}
```

Any sibling keys you omit (e.g. other entries under `chat`) keep their built-in
values.

### Ready-made examples

Working example override files ship in the repository under
[`examples/locales/`](../examples/locales/) (`en.json` and `de.json`). Copy them
into `contents/locales/` as a starting point.

### Good to know

- **Unknown keys are ignored.** If your override contains a key that does not
  exist in the built-in file, the server logs a warning
  (`Unknown locale key in overrides`) and skips it. This is your safety net for
  catching typos in key paths.
- **Adding a brand-new language** requires a matching built-in base file in
  `shared/i18n/`; `contents/locales/` is an override layer, not a full
  replacement. See [Localization](localization.md) for the full merge and
  language-detection details.

For the complete reference — merge behaviour, the translations endpoint, and
client-side language detection (URL parameter, `localStorage`, iframe embedding,
`BroadcastChannel`) — see **[Localization](localization.md)**.

---

## Other Customizations (all under `contents/`)

Labels and translations are the most common customization, but the same
"edit only `contents/`" principle applies to everything else:

| What you want to change                          | Where (under `contents/`)          | Reference                                  |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------ |
| UI text, labels, button captions                 | `contents/locales/{lang}.json`     | [Localization](localization.md)            |
| Branding, logo, colors, default language, layout | `contents/config/ui.json`          | [UI Configuration](ui.md)                  |
| Platform behaviour, auth, CORS                    | `contents/config/platform.json`    | [Platform Configuration](platform.md)      |
| AI applications                                   | `contents/apps/*.json`             | [App Configuration](apps.md)               |
| LLM models                                        | `contents/models/*.json`           | [Models](models.md)                        |
| User groups & permissions                         | `contents/config/groups.json`      | [Authentication Architecture](authentication-architecture.md) |
| Writing styles / output formatting                | `contents/config/styles.json`      | [Styles](styles.md)                        |
| Custom pages (Markdown or React)                  | `contents/pages/{lang}/{id}.md`/`.jsx` | [Content Management](content-management.md) |
| Knowledge sources                                 | `contents/config/sources.json`     | [Sources System](sources.md)               |
| Available tools                                   | `contents/tools/*.json`            | [Tools](tools.md)                          |

> **Config reload:** Apps, models, UI, groups, styles, sources, and tools reload
> automatically via the config cache. Changes to `platform.json` (server
> behaviour, auth) require a server restart. See
> [Configuration Validation](configuration-validation.md) if a change is not
> applied.

Most of these can also be edited through the **Admin UI** rather than by hand —
see the [Admin UI Guide](admin-ui.md). The Admin UI writes to the same
`contents/` files described above.

---

## Summary

- Customize **only** the `contents/` folder — never `shared/` or `server/`.
- To change **labels and translations**, create `contents/locales/{lang}.json`
  with just the keys you want to override; they deep-merge over the built-in
  `shared/i18n/{lang}.json` and apply to both server and client.
- For branding, apps, models, styles, and pages, use the corresponding files
  under `contents/` (or the Admin UI).
- Your customizations survive upgrades because the shipped defaults are never
  touched.
