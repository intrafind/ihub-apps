# iHub Chat for Nextcloud

> **Status:** development scaffold. This directory ships with the iHub Apps repo
> as a starting point for the Nextcloud-side app that drives the embedded
> iHub UI. It is intentionally minimal — enough to install on a dev Nextcloud
> instance and prove the full "Chat with iHub" flow end-to-end. Polishing for
> the Nextcloud App Store (i18n, signing, certification, screenshots) is not
> in scope of this skeleton.

This app adds a **Chat with iHub** action to the Nextcloud Files UI. When a
user clicks it, Nextcloud loads `<ihub-base-url>/nextcloud/taskpane.html` in
an iframe (or new tab — configurable) with the selected file paths encoded
in the URL hash. The embedded iHub UI takes it from there.

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
│   └── info.xml                  # App metadata (canonical version comes from iHub)
├── lib/
│   └── Controller/
│       └── PageController.php    # Renders the iframe host page
├── templates/
│   └── main.php                  # HTML host: iframe + file-action bridge
├── src/
│   └── main.js                   # JS bundle: file action + postMessage bridge
├── Makefile                      # build + package
└── README.md                     # this file
```

## Build

```bash
make build
```

Produces `js/main.js`. There is no transpilation step — the source uses only
features supported by Nextcloud's bundled bridges (ES2017+).

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
   <ihubBaseUrl>/nextcloud/taskpane.html#providerId=<id>&paths=<urlencoded-json>
   ```
3. It opens the URL inside an iframe pane (or a new tab — controlled by the
   admin setting). The iHub embed reads the hash, downloads the files
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
- The app does not register a sidebar/Apps page — for the v1 flow only
  the file action and the iframe host page are wired up. Adding a
  sidebar tab is a straightforward follow-up (uses the same iframe URL).
- No automated tests yet — please test manually before deploying to a
  production Nextcloud instance.

## Pointers

- iHub source of truth for the embed URL + info.xml is the iHub admin
  page (**Admin → Integrations → Nextcloud Embed**) — values are
  per-deployment.
- Nextcloud app developer docs:
  https://docs.nextcloud.com/server/latest/developer_manual/
- Nextcloud Files plugin API:
  https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/javascript.html#registering-file-actions
