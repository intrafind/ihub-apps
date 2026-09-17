# Nextcloud Embed Plugin

The Nextcloud Embed adds a **"Chat with iHub"** action to the Nextcloud Files
view. When a user selects one or more files and clicks the action, Nextcloud
navigates to a page that embeds iHub in an iframe, with the selected file
paths handed off through a URL hash. iHub picks any app, auto-attaches the
files to the chat, and the user starts working — without leaving Nextcloud.

This is different from the **Nextcloud Cloud Storage integration**
([nextcloud-integration.md](nextcloud-integration.md)) which lets users pick
files from inside an iHub chat. The embed plugin is the reverse direction:
start in Nextcloud, end up in iHub. They share the same per-user OAuth
grant — configuring one buys you most of the setup for the other.

## What admins need to do, end to end

1. **Enable both iHub integrations** that the embed depends on
   (Nextcloud cloud storage + Nextcloud Embed).
2. **Download the plugin tarball** from a GitHub release (or a CI artifact).
3. **Install it on Nextcloud** by extracting into `custom_apps/` and
   enabling the app via `occ`.
4. **Configure the plugin** with the iHub base URL and provider id.

A Nextcloud admin only owns steps 3–4. An iHub admin owns steps 1 and 2's
provisioning (releases happen in the iHub repo's CI). Both sides need to be
in place for the user-facing flow to work.

---

## Prerequisites

| Requirement | Why |
| --- | --- |
| Nextcloud 28–33 | The plugin uses `@nextcloud/files` v4 API. NC 28 is the lowest version that ships it; 33 is the highest tested target. |
| iHub Apps deployment reachable from end-user browsers over HTTPS | The plugin opens iHub inside an iframe on the user's browser — Nextcloud's server never contacts iHub. |
| Admin access to both iHub Apps and the Nextcloud instance | Both sides need configuration. |
| The Nextcloud Cloud Storage integration in iHub already configured | iHub downloads the selected documents on the user's behalf through this provider's OAuth grant. See [Nextcloud Integration](nextcloud-integration.md). |

---

## Step 1 — Enable the integrations in iHub Apps

The Nextcloud admin can skip this section; ask the iHub admin to do it.

### 1a. Cloud storage provider

Follow [docs/nextcloud-integration.md](nextcloud-integration.md) end to end.
Take note of the **provider id** you configured (e.g. `nextcloud-main`) —
the plugin needs to be told which provider it should announce to iHub.

### 1b. Nextcloud Embed

1. Sign in to iHub Apps as an administrator.
2. Open **Admin → Integrations → Nextcloud Embed**.
3. Click **Enable**. iHub auto-creates an internal OAuth client; you don't
   need to provision one manually.
4. Under **Allowed Nextcloud Origins**, add every Nextcloud origin that
   should be allowed to iframe iHub. Example:
   `https://nextcloud.example.com`. The embed page enforces this via the
   `frame-ancestors` Content-Security-Policy header — origins not in the
   list cannot load iHub inside an iframe.

> **Why two integrations?** The embed integration is the embed gate
> (CSP + OAuth client). The cloud storage integration is how iHub
> downloads the user's selected files. They're independent surfaces.

---

## Step 2 — Get the plugin tarball

Download `ihub_chat.tar.gz` from one of:

- **GitHub Releases (recommended for production):** every iHub Apps release
  attaches the plugin tarball as a release asset. Pick the release that
  matches the iHub server version you're running and download the asset.
- **CI artifact (for testing pre-release builds):** the
  `Build Nextcloud Plugin` workflow uploads a build artifact for every
  push to `main`. Open the workflow run and download `ihub_chat-<sha>.zip`
  (GitHub wraps artifacts in zip; unzip locally to get
  `ihub_chat.tar.gz`).
- **Self-build (for development):** clone the iHub repo and run
  `cd nextcloud-app && make package`. The output lands at
  `ihub_chat.tar.gz` in the repo root.

Verify the structure:

```bash
tar -tzf ihub_chat.tar.gz | head -5
# ihub_chat/
# ihub_chat/appinfo/
# ihub_chat/appinfo/info.xml
# ihub_chat/css/
# ihub_chat/img/
```

The top-level directory **must** be `ihub_chat/`. Nextcloud refuses to load
an app whose folder name doesn't match the id in `info.xml`.

---

## Step 3 — Install on the Nextcloud server

The plugin is not on the Nextcloud App Store yet, so install it by
extracting the tarball into your Nextcloud `custom_apps/` directory.
The exact path depends on how you deployed Nextcloud.

### Standalone / VM install

```bash
# Replace /var/www/html with your Nextcloud webroot.
NEXTCLOUD_ROOT=/var/www/html

sudo tar -xzf ihub_chat.tar.gz -C "$NEXTCLOUD_ROOT/custom_apps/"
sudo chown -R www-data:www-data "$NEXTCLOUD_ROOT/custom_apps/ihub_chat"
sudo -u www-data php "$NEXTCLOUD_ROOT/occ" app:enable ihub_chat
```

### Docker (official `nextcloud:apache` image)

```bash
# Container name = your compose service / k8s pod name.
CONTAINER=nextcloud

docker cp ihub_chat.tar.gz "$CONTAINER:/tmp/"
docker exec "$CONTAINER" sh -c '
  tar -xzf /tmp/ihub_chat.tar.gz -C /var/www/html/custom_apps/ &&
  chown -R www-data:www-data /var/www/html/custom_apps/ihub_chat &&
  rm /tmp/ihub_chat.tar.gz
'
docker exec -u www-data "$CONTAINER" php /var/www/html/occ app:enable ihub_chat
```

### Kubernetes / Helm

```bash
POD=$(kubectl -n nextcloud get pod -l app.kubernetes.io/name=nextcloud -o name | head -1)
kubectl -n nextcloud cp ihub_chat.tar.gz "${POD#pod/}:/tmp/ihub_chat.tar.gz"
kubectl -n nextcloud exec "$POD" -- sh -c '
  tar -xzf /tmp/ihub_chat.tar.gz -C /var/www/html/custom_apps/ &&
  chown -R www-data:www-data /var/www/html/custom_apps/ihub_chat
'
kubectl -n nextcloud exec "$POD" -- php /var/www/html/occ app:enable ihub_chat
```

---

## Step 4 — Configure the plugin

Two app config values control the plugin's behaviour. Set them via `occ`:

```bash
# The iHub Apps base URL — must be the same one users hit in their browsers.
sudo -u www-data php occ config:app:set ihub_chat ihub_base_url \
  --value=https://ihub.example.com

# The cloudStorage provider id from Step 1a. Defaults to `nextcloud-main`
# if you omit this; set it explicitly if you used a different id.
sudo -u www-data php occ config:app:set ihub_chat ihub_provider_id \
  --value=nextcloud-main
```

Verify:

```bash
sudo -u www-data php occ config:app:get ihub_chat ihub_base_url
sudo -u www-data php occ config:app:get ihub_chat ihub_provider_id
```

> **Use HTTPS in production:** the iHub base URL is loaded inside an iframe
> from a Nextcloud page that itself runs on HTTPS in any sane production
> deployment, and the browser blocks mixed content there. The plugin's URL
> validator (`nextcloud-app/src/shared.ts::safeBaseUrl`) accepts both `http:`
> and `https:` so a dev Nextcloud over plain HTTP can iframe a dev iHub on
> the same scheme; the production guarantee comes from the host page being
> HTTPS, not from the validator.

---

## Step 5 — Verify the end-user flow

1. Sign in to Nextcloud as a normal user.
2. Open **Files**, select one document, click the **"…" (more)** menu →
   **Chat with iHub**.
3. The same tab navigates to `/apps/ihub_chat/`. The iHub embed loads
   inside a Nextcloud page.
4. First-time users see an OAuth login screen — they sign in to iHub.
5. The apps list appears. A banner reads
   **"1 document selected from Nextcloud — pick an app to start a chat"**.
6. Picking an app sends the user to that app's chat with the selected
   document already attached. Sending a message uses the document as
   context.

If anything in this flow misbehaves, see **Troubleshooting** below.

---

## Updating the plugin

When a new iHub release is out:

1. Download the new `ihub_chat.tar.gz`.
2. Replace the files in `custom_apps/ihub_chat/`. The simplest atomic swap:

   ```bash
   TS=$(date +%Y%m%d-%H%M%S)
   mv custom_apps/ihub_chat "custom_apps/ihub_chat.bak.$TS"
   tar -xzf ihub_chat.tar.gz -C custom_apps/
   chown -R www-data:www-data custom_apps/ihub_chat
   ```

3. **Reset PHP opcache** so the running Apache process picks up the new
   PHP files. The standard `kubectl rollout restart` works, but if you
   need a no-downtime alternative, drop a one-shot reset script under the
   `ocs-provider/` path (which is exempt from Nextcloud's Rewrite-to-
   index.php rule) and hit it from inside the pod:

   ```bash
   cat > /var/www/html/ocs-provider/_opcache_reset.php <<'PHP'
   <?php
   if (function_exists('opcache_reset')) {
     echo opcache_reset() ? "OK\n" : "FAIL\n";
   }
   PHP
   chown www-data:www-data /var/www/html/ocs-provider/_opcache_reset.php
   curl -sS http://localhost/ocs-provider/_opcache_reset.php
   rm /var/www/html/ocs-provider/_opcache_reset.php
   ```

   Static assets (JS/CSS) bypass opcache; only PHP files (lib/, templates/)
   are affected. If you only changed JS, a hard refresh in the browser is
   enough.

4. Once verified, delete `custom_apps/ihub_chat.bak.*`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The "Chat with iHub" action doesn't appear in the Files menu. | Plugin not enabled, or browser cached the old Files JS bundle. | Run `occ app:list \| grep ihub_chat` — it should be under **Enabled apps**. Hard-refresh Files (Ctrl+Shift+R). |
| Clicking the action shows _"iHub Chat is not configured"_. | `ihub_base_url` is empty. | Set it via `occ config:app:set ihub_chat ihub_base_url --value=…`. |
| Clicking the action shows _"iHub Chat could not open"_. | The configured base URL or provider id failed validation (non-HTTP scheme, illegal characters, opaque-host, …). | Re-check the values stored via `occ config:app:get`. |
| Iframe shows a Content-Security-Policy error in the browser console. | The Nextcloud origin is not in iHub's **Allowed Nextcloud Origins**. | Open **iHub Admin → Integrations → Nextcloud Embed** and add the exact origin (including scheme, no trailing slash). |
| Iframe loads, but the user is shown as **anonymous** without an OAuth prompt. | A stale iHub access token sits in the iframe's localStorage. The full-embed entry probes `/api/oauth/userinfo` to detect this — if the probe fails the gate is shown. | Should auto-recover. If it doesn't, clear `office_ihubtoken` from the iHub origin's localStorage in devtools and reload. |
| Files don't auto-attach after the user picks an app. | iHub has no Nextcloud cloud storage provider with the id the plugin announces, or the user has not OAuth-linked Nextcloud to iHub. | Check the provider id matches (`occ config:app:get ihub_chat ihub_provider_id` ↔ iHub's cloudStorage providers list). The user can OAuth-link from any iHub chat via the cloud-storage picker. |
| Updated plugin files but old behaviour persists. | PHP opcache. | See **Updating the plugin** above. |

---

## Architecture sketch

```
┌────────────────────────┐                ┌─────────────────────────────┐
│ Nextcloud (browser)    │                │ iHub Apps (browser)         │
│ • Files plugin JS      │                │ • full-embed.html iframe    │
│ • "Chat with iHub"     │                │ • OAuth login → token       │
│   navigates to         │ <───iframe──── │ • Reads selection from hash │
│   /apps/ihub_chat/#…   │                │ • Downloads files via       │
│ • PageController       │                │   /api/integrations/        │
│   renders the host     │                │   nextcloud/download        │
│   page (templates/     │                │ • Auto-attaches to chat     │
│   main.php)            │                └─────────────────────────────┘
└────────────────────────┘                              │
                                                        │ Bearer iHub token
                                                        ▼
                                          ┌──────────────────────────────┐
                                          │ iHub Apps (server)           │
                                          │ • OAuth client (per user)    │
                                          │ • Cloud-storage provider     │
                                          │   downloads from Nextcloud   │
                                          │   via WebDAV                 │
                                          └──────────────────────────────┘
```

- The Nextcloud server never talks to iHub. All transit is browser-side.
- iHub talks to Nextcloud (server-to-server) only when downloading user-
  selected documents, using the per-user OAuth token from the cloud-
  storage integration.
- Selection is encoded in the URL hash
  (`#providerId=<id>&paths=<json>`) — never in query params — so it
  doesn't show up in Nextcloud's access logs.
