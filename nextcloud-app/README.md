# iHub Chat for Nextcloud

> **Status:** development scaffold. This directory ships with the iHub Apps repo
> as a starting point for the Nextcloud-side app that drives the embedded
> iHub UI. It is intentionally minimal — enough to install on a dev Nextcloud
> instance and prove the full "Chat with iHub" flow end-to-end. Polishing for
> the Nextcloud App Store (i18n, signing, certification, screenshots) is not
> in scope of this skeleton.

This app adds a **Chat with iHub** action to the Nextcloud Files UI. When a
user clicks it, Nextcloud loads `<ihub-base-url>/nextcloud/full-embed.html`
in an iframe inside the Nextcloud chrome (top nav, sidebar stay visible),
with the selected file paths encoded in the URL hash. The embedded iHub UI
takes it from there.

iHub authenticates the user against its own OAuth client (auto-created when
the admin enables **Admin → Integrations → Nextcloud Embed** in iHub). iHub
reads the selected Nextcloud documents through its own per-user OAuth
grant against Nextcloud's `/apps/oauth2/...` endpoints — the user OAuth-links
once and the same grant powers both this embed and the in-iHub cloud picker.
**No Nextcloud token is ever passed to iHub by this app.**

## Layout

```
nextcloud-app/
├── appinfo/
│   ├── info.xml                  # App metadata (NC 28-33, navigation entry)
│   └── routes.php                # `page#index` → /
├── img/
│   └── app.svg                   # iHub logo (top-nav + file-action icon)
├── lib/
│   ├── AppInfo/Application.php   # IBootstrap — registers event listener
│   ├── Controller/PageController.php   # Renders the iframe host page
│   └── Listener/LoadScriptsListener.php  # Injects JS + initial state on Files page
├── templates/
│   └── main.php                  # HTML host: iframe mount point
├── src/
│   ├── files-init.ts             # @nextcloud/files FileAction registration
│   ├── main.ts                   # Iframe host bootstrap (loadState + postMessage)
│   └── shared.ts                 # URL/path validation helpers
├── css/main.css                  # Host page styles
├── package.json                  # npm deps (Vite, @nextcloud/files, l10n, dialogs, initial-state)
├── vite.config.ts                # @nextcloud/vite-config preset, two entries
├── tsconfig.json                 # TypeScript config
├── Makefile                      # build + package
└── README.md                     # this file
```

## Build

```bash
make install        # npm ci (first time, or after deps change)
make build          # Vite produces js/ihub_chat-{main,files-init}.mjs
# or just:
make build          # also runs `make install`
```

Requires Node 20+, npm 10+. Output goes to `js/` (gitignored — built fresh per
release). The Vite preset (`@nextcloud/vite-config`) marks Vue and Nextcloud
globals as externals and emits `.mjs` bundles in the layout the Nextcloud
`Util::addScript` / `script()` helpers expect.

## Install on a dev Nextcloud instance

1. Make sure the iHub side is enabled:
   - **Admin → Integrations → Nextcloud Embed → Enable**
   - Add your Nextcloud origin (e.g. `https://cloud.example.com`) to
     **Allowed Nextcloud Origins**.
2. In iHub, also enable the **Nextcloud cloud-storage provider**
   (Admin → Integrations → Nextcloud) so end users have a path to OAuth-link
   their Nextcloud account. Use the same provider id you will configure
   in this app's `IHUB_PROVIDER_ID` setting (default: `nextcloud-main`).
3. Copy this directory into Nextcloud's apps folder:
   ```bash
   cp -R . /var/www/nextcloud/apps/ihub_chat/
   sudo chown -R www-data:www-data /var/www/nextcloud/apps/ihub_chat
   ```
4. Enable the app:
   ```bash
   sudo -u www-data php /var/www/nextcloud/occ app:enable ihub_chat
   ```
5. As a Nextcloud admin, open **Settings → Administration → iHub Chat** and
   set:
   - **iHub base URL** — e.g. `https://ihub.example.com`
   - **iHub provider id** — must match the provider id used in iHub
     Admin → Integrations → Nextcloud (default `nextcloud-main`)

## How the file action works

`src/main.js` registers a custom action on the Nextcloud Files plugin
registry. When the user clicks it on one or more selected files:

1. The script collects each selected file's path (relative to the user's
   Nextcloud root, e.g. `/Reports/q1.pdf`).
2. It builds the iHub embed URL:
   ```
   <ihubBaseUrl>/nextcloud/full-embed.html#providerId=<id>&paths=<urlencoded-json>
   ```
3. It navigates to the app's host page (`/apps/ihub_chat/`), which iframes
   the embed URL above. The iHub embed reads the hash, downloads the files
   through `/api/integrations/nextcloud/download`, and renders the chat UI.

When the user changes the selection while the iframe is mounted, the
script also `postMessage`s an update to the iframe:

```js
{
  kind: 'ihub.nextcloud.selection',
  providerId: 'nextcloud-main',
  paths: ['/Reports/q1.pdf', '/Memos/2026-q2.md']
}
```

The iHub embed's bridge validates `event.origin` against its admin-
configured `allowedHostOrigins` and ignores any payload from an origin
not on that list.

## Limitations of this skeleton

- The app does not yet ship a polished settings UI; admins set the iHub
  base URL via `occ config:app:set ihub_chat ihub_base_url --value=…`.
- The iHub logo (`img/app.svg`) is rendered as-is in the Nextcloud top
  nav. Nextcloud's theming filter expects monochrome SVGs; a multi-color
  brand mark will display with its own colors rather than the theme's
  accent. Provide a monochrome alternative if you want full theme
  integration.
- No automated tests yet — please test manually before deploying to a
  production Nextcloud instance.

## Pointers

- iHub source of truth for the embed URL is the iHub admin page
  (**Admin → Integrations → Nextcloud Embed**) — values are
  per-deployment. The `appinfo/info.xml` shipped here is the canonical
  metadata; iHub does not generate a competing one.
- Nextcloud app developer docs:
  https://docs.nextcloud.com/server/latest/developer_manual/
- Nextcloud Files plugin API:
  https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/javascript.html#registering-file-actions
