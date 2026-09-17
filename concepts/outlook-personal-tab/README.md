# Outlook Personal Tab — concept docs

This folder collects the design docs for surfacing iHub Apps on the
**Microsoft 365 left app rail** — the global app launcher in the new
Outlook (Outlook on the web, new Outlook for Windows/Mac), Microsoft
Teams, and Microsoft 365 Copilot.

This is a **complement, not a replacement**, for the existing
[Outlook task-pane add-in](../../docs/outlook-add-in.md). That add-in
surfaces per-email assistance on the mail-item ribbon. This concept
adds a second surface that hosts the full iHub UI as a "personal tab"
on the host's app bar.

## Documents

- [Outlook M365 Personal Tab Integration (design)](./2026-05-19%20Outlook%20M365%20Personal%20Tab%20Integration.md)

## TL;DR

- Build it as a **Teams personal tab packaged with the unified
  Microsoft 365 manifest (v1.20)**. One ZIP surfaces on Outlook (new),
  Teams, and M365 Copilot.
- Reuse the iframe/embed plumbing from
  [`nextcloud-embed`](../nextcloud-embed/): public PKCE OAuth client
  auto-created on admin "Enable", dynamic CSP `frame-ancestors`,
  same `client/src/features/office/` host adapter pattern.
- iHub auth: continue using the existing OAuth2 + PKCE popup against
  whichever provider iHub itself talks to (OIDC, local, LDAP, …).
  Optionally upgrade later to Microsoft Teams SSO via Nested App
  Authentication (NAA) for a popup-free experience when the user is
  signed into Entra ID.
- Distribution mirrors the existing add-in: admin enables in
  `Admin → Office Integration`, downloads the manifest package, uploads
  in **Microsoft 365 Admin Center → Settings → Integrated apps**.
- Classic Win32 Outlook is **not** a target — it has no M365 app rail.
  Those users keep the existing task-pane add-in.
