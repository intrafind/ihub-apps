# Outlook Add-in Rollout Guide

This guide walks an administrator through deploying the iHub Apps **Outlook add-in** to an entire organization. The add-in adds a task pane to Outlook (desktop, web, and mobile) that lets users chat with iHub apps using the currently selected email — including subject, body, and attachments — as context.

> This page covers the **Outlook task-pane add-in**. For browsing OneDrive / SharePoint / Teams files inside iHub chat, see [Office 365 Integration](office365-integration.md). The two integrations are independent and can be enabled separately.

---

## What gets deployed

When the integration is enabled, iHub Apps exposes the following endpoints on your deployment:

| Endpoint | Purpose |
|---|---|
| `GET /api/integrations/office-addin/manifest.xml` | Office add-in manifest, generated dynamically with the deployment's URLs |
| `GET /api/integrations/office-addin/config` | Runtime config (base URL, OAuth client ID, redirect URI, starter prompts) consumed by the task pane |
| `GET /office/taskpane.html` | Task-pane UI that loads inside Outlook |
| `GET /office/commands.html` | Command surface used by Outlook ribbon buttons |
| `GET /office/callback.html` | OAuth (PKCE) redirect target for sign-in |
| `GET /office/assets/icon-{16,32,64,80,128}.png` | Add-in icons |

All routes are gated behind the `integrations` feature flag and the `officeIntegration.enabled` setting — both must be on.

---

## Prerequisites

Before starting the rollout, confirm:

1. **Public HTTPS URL.** Outlook (especially Outlook on the web and mobile) refuses to load add-in assets over plain HTTP. Your iHub deployment must be reachable from end-user devices over HTTPS with a trusted certificate. See [SSL Certificates](ssl-certificates.md).
2. **Reverse proxy headers configured.** The manifest URLs and OAuth redirect URI are derived from the incoming request. If iHub runs behind a reverse proxy, make sure `X-Forwarded-Proto` and `X-Forwarded-Host` are forwarded correctly. See [Production Reverse Proxy Guide](production-reverse-proxy-guide.md).
3. **Microsoft 365 tenant admin access.** You need a role that can deploy custom apps from the Microsoft 365 Admin Center — typically **Global Administrator**, **Exchange Administrator**, or a custom role with the *Manage Office Apps* permission.
4. **A working iHub authentication backend.** The add-in does not bring its own user identity — it logs users in via iHub's OAuth Authorization Code flow, which delegates to whichever auth provider iHub itself uses (local, OIDC, proxy, LDAP, NTLM). Confirm regular browser sign-in works first.
5. **Outlook clients on Mailbox API 1.5 or later.** Modern Outlook (Microsoft 365 Apps, Outlook on the web, the new Outlook for Windows, Outlook for Mac, Outlook Mobile) all qualify. Reading email attachments via the add-in additionally requires Mailbox API 1.8.

---

## Step 1 — Enable the `integrations` feature flag

The Outlook add-in routes are gated behind iHub's `integrations` feature. In **Admin → Platform Settings**, or directly in `contents/config/platform.json`:

```json
{
  "features": {
    "integrations": true
  }
}
```

Save and (if you edited the file directly) restart the server. Without this flag, every Office add-in URL returns 404.

---

## Step 2 — Enable the Outlook add-in in the iHub admin UI

1. Sign in to iHub Apps as an administrator.
2. Open **Admin → Office Integration** (`/admin/office-integration`).
3. Click **Enable**.

This single action does the following automatically — no manual `platform.json` editing required:

- Creates a new **OAuth public client** named *Office Add-in* with PKCE, the `authorization_code` and `refresh_token` grants, scopes `openid profile email`, and the redirect URI `{yourBaseUrl}/office/callback.html`.
- Turns on `oauth.enabled.authz`, `oauth.enabled.clients`, `oauth.authorizationCodeEnabled`, and `oauth.refreshTokenEnabled` in `platform.json`.
- Sets `officeIntegration.enabled = true` and stores the new `oauthClientId`.

After enabling, the page shows the OAuth client ID with a link to **View OAuth Client** (`/admin/oauth/clients/{id}`) where you can audit or restrict it (see [Step 5](#step-5--optional-restrict-what-the-add-in-can-access)).

> If you ever rotate or delete this client manually, click **Disable** then **Enable** again to recreate it. The system is idempotent — it only creates a new client when `oauthClientId` is empty.

---

## Step 3 — Customize display name, description, and starter prompts

Still on the **Office Integration** admin page:

- **Display Name** — appears as the add-in name in Outlook's ribbon and the M365 Admin Center listing. Localize for each language your users see (`en`, `de`, …). Required, max 250 chars per locale.
- **Description** — short blurb shown alongside the name. Max 250 chars per locale.
- **Starter Prompts** — up to 20 quick-action prompts displayed when the user opens the add-in on an email. Each has a **Title** (button label) and **Message** (the prompt sent on click, max 4000 chars). Prompts can be reordered with the up/down arrows. They are used as the default suggestions when the user-selected app does not declare its own starter prompts.

Click **Save**. Display Name and Description changes are picked up on the next manifest fetch — you do **not** need to redeploy the manifest unless the `<DisplayName>` text needs to change in M365 Admin Center listings (it is read at upload time).

---

## Step 4 — Deploy the manifest via Microsoft 365 Admin Center (centralized deployment)

The recommended way to roll the add-in out to all users is **Centralized Deployment** through the Microsoft 365 Admin Center. This installs the add-in tenant-wide; users do not need to add it themselves.

1. On the **Office Integration** admin page, copy the **Manifest URL** shown (or click **Download** to save `manifest.xml`). The URL looks like:

   ```
   https://your-ihub-domain.com/api/integrations/office-addin/manifest.xml
   ```

2. Sign in to the [Microsoft 365 Admin Center](https://admin.microsoft.com) as a Global or Exchange Administrator.
3. Go to **Settings → Integrated apps**.
4. Click **Upload custom apps**.
5. Choose **Office Add-in** as the app type.
6. Select **Provide link to manifest file** and paste the manifest URL — or pick **Upload manifest file (.xml) from device** and use the downloaded file.

   > Linking to the URL is preferred: every time Microsoft re-validates the manifest it will pick up your latest Display Name / Description from iHub. Uploading the file freezes the manifest at the time of upload.

7. Microsoft validates the manifest. If validation fails, see [Troubleshooting](#troubleshooting).
8. Choose who gets the add-in:
   - **Entire organization** — every mailbox in the tenant.
   - **Specific users / groups** — recommended for staged rollout. Use a security group like `iHub Pilot Users` first, then expand.
9. Review and click **Deploy**.

**Propagation time.** Microsoft typically rolls deployed add-ins out to user mailboxes within 6 hours; in some tenants it can take up to 24 hours. The add-in then appears under the Outlook **Apps** pane (new Outlook / Outlook on the web) or **Get Add-ins → Admin-managed** (classic Outlook).

> **Exchange-only tenants.** If you do not use the M365 Admin Center, the equivalent path is **Exchange Admin Center → Organization → Add-ins → +** (`https://admin.exchange.microsoft.com/#/addins`). Same manifest, same outcome.

---

## Step 5 — (Optional) Restrict what the add-in can access

By default, when a user signs into the add-in the resulting OAuth token grants access to the **same apps and models the user already has** through their iHub group memberships. If you want the add-in to expose only a subset (for example, only one or two purpose-built apps for triaging email), use the OAuth client's allow-lists.

1. Open **Admin → OAuth Clients** and select the *Office Add-in* client (the **View OAuth Client** link on the Office Integration page jumps directly to it).
2. Set **Allowed Apps** and/or **Allowed Models** to the specific resources the add-in should expose.

Semantics, in short:

- **Empty allow-list** → no client-level restriction. The user sees everything they normally can.
- **Non-empty allow-list** → the user sees only the **intersection** of their group permissions and the allow-list. The client cannot grant access the user does not already have.
- Authorization-code tokens **never** carry admin privileges, even if the signed-in user is an administrator.

The full design is in [OAuth Client Permission Filter for Authorization Code Flow](../concepts/2026-04-21%20OAuth%20Client%20Permission%20Filter%20for%20Authorization%20Code%20Flow.md).

---

## Step 6 — Verify the rollout

Once Microsoft has propagated the deployment:

1. **Open Outlook** as a pilot user.
2. Select an email. The add-in should appear in the message reading pane (look for your configured **Display Name** and icon).
3. Click the add-in. The task pane opens and shows the **Sign in to iHub** screen.
4. Click **Sign in**. A popup performs the PKCE OAuth flow against iHub and returns to `/office/callback.html`.
5. After sign-in, the chat panel opens. Selecting different emails should reset the chat and load the new email's subject, body, and attachments as context.
6. Send a starter prompt and confirm a streaming response appears.

Watch the iHub server logs (`npm run logs`) during the first sign-in. The OAuth handshake and any token validation issues are logged with component `JwtAuth` or `OfficeAddinRoutes`.

---

## Updating an existing deployment

| Change | Action required |
|---|---|
| Edit Display Name / Description in admin UI | None for users; Microsoft will refresh the manifest within ~24h. To force-refresh, re-link the manifest in M365 Admin Center. |
| Edit starter prompts | None — prompts are fetched live by the task pane on every open. |
| Change iHub deployment URL (e.g., move to a new domain) | The manifest auto-regenerates with the new host. In M365 Admin Center, **remove the old deployed add-in and re-upload from the new manifest URL** — Microsoft caches the URLs from the manifest at deploy time. |
| Rotate the OAuth client | Click **Disable** then **Enable** on the Office Integration page. Existing user sessions need to sign in again. The manifest URL is unchanged. |
| Upgrade iHub | No add-in action needed unless the manifest schema changes — release notes will call this out. |

---

## Disabling the add-in

In **Admin → Office Integration**, click **Disable**. This sets `officeIntegration.enabled = false`. All Outlook add-in routes immediately return 404, the task pane stops working for users, and Outlook will display an error in place of the add-in.

To fully remove the add-in from users' Outlook clients, also remove it in **Microsoft 365 Admin Center → Integrated apps**.

The OAuth client and other OAuth flags are left in place by **Disable** so re-enabling is one click. To purge the client, delete it manually under **Admin → OAuth Clients**.

---

## Troubleshooting

### Manifest URL returns 404 or "Office integration is not enabled"

- The `integrations` feature flag is off, **or** `officeIntegration.enabled` is false. Toggle both on (Steps 1 and 2).
- The `integrations` feature flag is loaded from `platform.json`, which requires a server restart after manual edits.

### Microsoft 365 Admin Center rejects the manifest with "Apps for Office manifest schema validation error"

- The hostname in the manifest's `<AppDomains>` and `<SourceLocation>` URLs must be **HTTPS** with a publicly trusted certificate. Self-signed certs are rejected.
- Hit the manifest URL directly in a browser and check the URLs printed in the XML — they must match the public hostname users will connect to. If they show an internal hostname or `http://`, fix your reverse proxy headers (`X-Forwarded-Proto`, `X-Forwarded-Host`).

### The add-in icon is missing or broken in Outlook

- Outlook fetches `/office/assets/icon-*.png` directly from the iHub host. Confirm those URLs return the PNGs (HTTP 200, `Content-Type: image/png`) without authentication.
- A common cause is an upstream WAF or auth proxy demanding credentials for `/office/*`. Allow these paths anonymously.

### Sign-in popup shows "redirect_uri_mismatch" or fails to close

- The OAuth client's redirect URI must be exactly `{baseUrl}/office/callback.html`. If you changed the iHub base URL, click **Disable** and **Enable** to recreate the client with the new URL.
- If you customized the OAuth client manually, confirm `{baseUrl}/office/callback.html` is in its **Redirect URIs** list.

### Sign-in succeeds but the user sees "no apps available"

- The Office Add-in OAuth client has an **Allowed Apps** allow-list that intersects to nothing for this user. Either widen the allow-list or grant the user a group with access to those apps.
- Confirm with [OAuth Client Permission Filter](../concepts/2026-04-21%20OAuth%20Client%20Permission%20Filter%20for%20Authorization%20Code%20Flow.md) — anonymous users with no groups will see nothing here unless the apps have anonymous access.

### "Add-in could not be started" / blank task pane

- Open the task pane in a browser at `{baseUrl}/office/taskpane.html`. If it does not load there, the issue is iHub-side (build assets missing, base URL misconfigured).
- In Outlook on the web, open browser DevTools → Network and reload the add-in. Look for blocked CORS or 401 responses.
- The add-in calls `/api/integrations/office-addin/config` before authenticating. That route is intentionally unauthenticated — make sure your reverse proxy or WAF is not requiring auth on `/api/integrations/office-addin/*`.

### Email attachments are not picked up

- Reading attachments needs Mailbox API **1.8+**. Outlook on the web and current desktop Outlook satisfy this; very old Outlook 2016 builds may not.
- Inline images and item attachments are filtered out — only file attachments are forwarded as chat context.
- Total attachment size is capped by iHub's normal upload limits — see [File Upload Feature](file-upload-feature.md).

### CI / staging environments

For non-production tests, sideload the manifest instead of using centralized deployment:

- **Outlook on the web:** *Settings → Mail → Customize actions → Get Add-ins → My add-ins → Add a custom add-in → Add from URL.*
- **New Outlook for Windows / Mac:** *Apps → Get add-ins → My add-ins → Add a custom add-in → Add from URL.*

Sideloading is per-user and ideal for QA, but does not survive mailbox moves and is not recommended for end users.

---

## Reference

- **Admin UI:** `/admin/office-integration` ([`AdminOfficeIntegrationPage.jsx`](../client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx))
- **Server routes:**
  - [`server/routes/integrations/officeAddin.js`](../server/routes/integrations/officeAddin.js) — manifest + runtime config
  - [`server/routes/admin/officeIntegration.js`](../server/routes/admin/officeIntegration.js) — admin enable/disable/config
  - [`server/routes/office.js`](../server/routes/office.js) — task pane + asset serving
- **Default config:** `officeIntegration` block in [`server/defaults/config/platform.json`](../server/defaults/config/platform.json)
- **Migrations:** `V028__add_office_integration_config.js`, `V029__fix_empty_office_description.js`, `V030__add_office_integration_starter_prompts.js`
- **Related docs:** [OAuth Authorization Code Flow](oauth-authorization-code.md), [Office 365 Integration](office365-integration.md), [Production Reverse Proxy Guide](production-reverse-proxy-guide.md), [SSL Certificates](ssl-certificates.md)
