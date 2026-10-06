# Microsoft 365 Copilot Agent

iHub can be an **agent in Microsoft 365 Copilot**. Users pick it in Copilot Chat or in Copilot's pane in Outlook, Teams, Word and the other Microsoft 365 apps, and Copilot runs iHub's apps for them — signed in with their own iHub account, seeing exactly the apps their iHub groups allow.

It is a *declarative agent* with one action: iHub's [MCP gateway](mcp-integration.md#inbound--exposing-ihub-as-an-mcp-server). The gateway offers every iHub app as a tool (`app__<appId>`), next to iHub's workflows (`workflow__<id>`) and tools. Copilot reads that list when the agent runs, so apps added, changed or removed in iHub show up without a new package.

> This is not the [Outlook add-in](outlook-add-in.md). The add-in is iHub's own UI in an Outlook task pane, working on the email that is open. The agent lives inside Copilot's UI: Copilot decides when to call which iHub app, and it does not get the open email (Microsoft does not offer that to agents). The two work side by side.

---

## What you need

- **Microsoft 365 Copilot** for the users who should get the agent. Agents with actions also work in Copilot Chat; check Microsoft's current licensing for your tenant.
- **A public HTTPS address for iHub** that Microsoft's cloud can reach — Copilot calls the gateway from Microsoft's servers, not from the user's machine. See [What has to be reachable](#what-has-to-be-reachable).
- **Admin access** to iHub, to the [Teams Developer Portal](https://dev.teams.microsoft.com/tools) of your tenant, and to the Microsoft 365 admin center (a role that can upload custom agents or apps).

### What has to be reachable

Unlike the Outlook add-in — which runs on the user's device and only needs iHub to be reachable from there, so an internal address on the company network or VPN is enough — the Copilot agent is driven from Microsoft's cloud. Two parts of the flow come from Microsoft's servers, one from the user's browser:

| Who calls | Path (under iHub's base path) | Must be reachable from |
|---|---|---|
| Copilot, for every tool call | `/mcp` | **the internet** (Microsoft's cloud) |
| Microsoft's token service, to exchange the sign-in code and refresh tokens | `/api/oauth/token` | **the internet** (Microsoft's cloud) |
| The user's browser, when Copilot asks them to sign in | `/api/oauth/authorize`, `/api/oauth/authorize/decision`, iHub's sign-in page and whatever identity provider iHub uses | the user's browser — an internal address works for users on the company network or VPN |

- The address must use **HTTPS with a publicly trusted certificate** — an internal CA is not trusted by Microsoft's servers. Admin → Microsoft 365 Copilot does not build the package while iHub's public address is plain `http://`; set the MCP gateway's **Public URL** to the HTTPS address. Without a Public URL the address comes from the request, and `X-Forwarded-Proto` / `X-Forwarded-Host` count only from a proxy that [`trustProxy`](rate-limiting.md#proxy-hops-and-the-rate-limit-key) trusts.
- A reverse proxy or WAF in front of iHub can publish just the two server-to-server paths (`/mcp`, `/api/oauth/token`) to the internet and keep the rest internal. Neither hands out anything without credentials: `/mcp` accepts only iHub-issued OAuth tokens with the `mcp:*` scopes, and the token endpoint issues tokens only for a valid sign-in code (with the agent client's secret) or a valid refresh token.
- To our knowledge Microsoft publishes no dedicated address range for these calls; check Microsoft's current documentation before relying on an IP allow-list to limit who can reach them.
- Set the gateway's **Public URL** (Admin → MCP gateway) to the address Microsoft should use; the registration values, the package and the gateway's own discovery documents all follow it.

---

## Step 1 — Enable the agent in iHub

**Admin → Integrations → Microsoft 365 Copilot** (`/admin/copilot-agent`) → **Enable**.

Enabling sets up what the agent needs:

- an OAuth client **Microsoft 365 Copilot** (confidential, authorization code + refresh token, redirect URI `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`, scopes `openid profile email mcp:tools:read mcp:tools:call mcp:apps:invoke mcp:workflows:run`). Its **client secret is shown once**, right after enabling — copy it for step 2. Lost it? **Issue a new secret** on the same page;
- the OAuth authorization server (`oauth.enabled.authz`);
- the **MCP gateway** (`mcpServer.enabled`), which the agent calls.

The status card checks the prerequisites, including that the gateway offers apps (*Apps* under the gateway's exposed capabilities, Admin → MCP gateway).

---

## Step 2 — Register the sign-in in the Teams Developer Portal

Copilot signs users in to iHub through an OAuth client registration in the Teams Developer Portal. Microsoft offers no API for this, so it is done once by hand:

1. Open the [Teams Developer Portal](https://dev.teams.microsoft.com/tools) → **Tools** → **OAuth client registration** → **Register client**.
2. Fill in the values the iHub admin page shows, each with a copy button:

   | Portal field | Value |
   |---|---|
   | Base URL | the gateway's address, `{iHub}/mcp` — it must match the address in the package exactly, or every call fails |
   | Restrict usage by org | *My organization only* |
   | Restrict usage by app | **Any Teams app** — restricting it to an app makes every tool call fail |
   | Client ID / Client secret | from step 1 |
   | Authorization endpoint | `{iHub}/api/oauth/authorize` |
   | Token endpoint / Refresh endpoint | `{iHub}/api/oauth/token` |
   | Scope | `openid profile email mcp:tools:read mcp:tools:call mcp:apps:invoke mcp:workflows:run` |
   | Enable PKCE | on |

3. Save. The portal shows an **OAuth client registration ID**. Paste it into **OAuth client registration ID** on the iHub page and save.

Every address on the page and in the package — the gateway, the OAuth endpoints, the links in the app manifest — is built from the gateway's **Public URL** (Admin → MCP gateway) when one is set, otherwise from the address the admin page was opened with. Set the Public URL when iHub sits behind a reverse proxy or is reached under a different name from outside.

---

## Step 3 — Describe the agent (optional)

- **Name** (up to 30 characters) and **Description** — what users see in Copilot's agent list.
- **Instructions** — what Copilot is told about iHub. Empty uses iHub's default instructions (shown as the placeholder): call the app that matches the request with the user's words as `message`, prefer the organization's apps over general knowledge, keep the apps' sources. Up to 8,000 characters.
- **Conversation starters** — up to 12 suggestions Copilot shows when the agent is opened.

---

## Step 4 — Download the package and upload it

**Download agent package** builds `ihub-copilot-agent.zip`:

| File | Content |
|---|---|
| `manifest.json` | Microsoft 365 app manifest (schema 1.30) |
| `declarativeAgent.json` | the agent: name, description, instructions, starters (schema v1.8) |
| `ihub-plugin.json` | the action: a `RemoteMCPServer` runtime pointing at the gateway, signed in through the registration ID, discovering the tools at runtime (schema v2.4) |
| `color.png`, `outline.png` | 192 × 192 colour icon and 32 × 32 white outline icon |

Upload it in the **Microsoft 365 admin center** → **Copilot** → **Agents** → **Upload custom agent**, and choose who gets it. For a first test, a user may also side-load it in Teams (Apps → Manage your apps → Upload an app) when the Teams setup policy allows uploading custom apps.

Every download carries a new version (`year.month.DDHHmmss`, UTC), because Microsoft 365 wants a higher version on every re-upload. After changing the name, description, instructions, starters or the registration ID, download again and upload the new package over the old one. Apps added or changed in iHub need no new package.

---

## What users see

The first time a user uses the agent, Copilot asks them to sign in: iHub's sign-in page opens (or iHub's identity provider), followed by iHub's consent page for the gateway's scopes (`mcpServer.requireConsent`). The consent is remembered (`oauth.consentMemoryDays`, 90 days by default). From then on Copilot calls iHub as that user:

- the apps are the ones the user's groups allow — restrict them further for Copilot with **Allowed apps** on the *Microsoft 365 Copilot* OAuth client (Admin → OAuth → clients);
- the user's iHub permissions, rate limits and usage tracking apply as for any other iHub request.

---

## Disabling

**Disable** deactivates the agent's OAuth client: Copilot's tokens stop working at once and the agent's calls fail with *unauthorized*. The gateway stays on — other MCP clients may use it; turn it off under Admin → MCP gateway if nothing else needs it. Remove the agent from the Microsoft 365 admin center as well, so users stop seeing it. **Enable** again reactivates the same client, secret and app id: the Teams registration and the uploaded package keep working. If the client was deleted, **Enable** creates a new one with a new secret and clears the registration ID: register the new client in the Teams Developer Portal (step 2) and download the package again.

---

## Limitations and troubleshooting

- **Copilot does not see the open email.** Microsoft 365 does not hand the open Outlook item to agents; users paste the text they want worked on, or use the Outlook add-in for email-centred work.
- **All of Copilot's token requests come from Microsoft's servers.** Copilot signs users in and refreshes their tokens from a few Microsoft addresses: about once an hour per active user, with the default token lifetime of 60 minutes. All of these count against one per-address OAuth limit (`rateLimit.oauthApi`, 300 requests per minute by default), which covers several thousand active users. For more, raise it under **Admin → Security → Rate limits** and restart the server. Until then, refreshes beyond the limit get HTTP 429 and Copilot asks users to sign in again. A longer token lifetime on the *Microsoft 365 Copilot* OAuth client (`tokenExpirationMinutes`) also means fewer refreshes. Wrong client secrets have their own, much lower limit (`rateLimit.oauthTokenApi`, 30 failed requests per 15 minutes); successful token requests never count against it. See [Rate limiting](rate-limiting.md).
- **Several iHub instances behind a load balancer** — the gateway's sessions live in one instance; set the gateway to stateless mode (`mcpServer.transports.streamableHttp.stateless: true`) unless the balancer keeps a client on one instance.
- **Every tool call fails with 401** — the Base URL of the Teams registration does not match the gateway's address in the package, or the agent was disabled. **404 on every tool call** — the registration is restricted to an app; set *Restrict usage by app* to *Any Teams app*.
- **The agent lists no iHub apps** — the gateway does not expose apps (Admin → MCP gateway → exposed capabilities), or the user's groups allow none, or the OAuth client's *Allowed apps* exclude them.
- **"Invalid redirect URI"** on sign-in — the OAuth client's redirect URIs must contain `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` (enabling adds it).

---

## Reference

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/copilot-agent/status` | settings, prerequisites, Teams Developer Portal values |
| `POST /api/admin/copilot-agent/enable` / `disable` | turn the agent on (creating the OAuth client) or off (deactivating it) |
| `PUT /api/admin/copilot-agent/config` | `oauthReferenceId`, `name`, `description`, `instructions`, `conversationStarters` |
| `POST /api/admin/copilot-agent/rotate-secret` | new client secret, shown once |
| `GET /api/admin/copilot-agent/package.zip` | the package |

Configuration lives in `platform.json` under `copilotAgent` (`enabled`, `appId`, `oauthClientId`, `oauthReferenceId`, `name`, `description`, `instructions`, `conversationStarters`); existing installations get the section through migration `V158`.
