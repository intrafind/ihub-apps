# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.

## Google Drive: Sign-In Works Behind Chained Proxies

Connecting Google Drive failed with a redirect URI mismatch on installations behind more than one
proxy when no redirect URI was configured for the provider. The automatically detected callback
URL took the proxy's forwarded host and protocol verbatim, so a chain such as
`X-Forwarded-Host: apps.example.com, proxy.internal` ended up in the URL Google was asked to
return to. Google Drive now reads the first entry of the chain, as Office 365 and Nextcloud
already did.

## Sign-In Return Links Can No Longer Point to Other Sites

After connecting Office 365, Google Drive, Nextcloud, Jira or an MCP server, users are sent back to
the page they came from. That return link was checked to stay on the iHub site, but links written
with a backslash or a hidden tab, such as `/\other-site.example`, slipped through and are read by
browsers as a link to another site. They are now rejected and the user returns to the default
page instead. Return links to pages inside iHub work as before.

## Deleting a User Now Ends Their Session, for Every Sign-In Method

Deleting a user who signed in through OIDC, LDAP, Microsoft Teams or NTLM did not cut off their
access: they kept using iHub with their existing session until it expired (8 hours by default,
longer if the session timeout was raised). Only deleted local (username/password) accounts were
signed out at once. A deleted user is now refused on their next request, whichever way they
signed in, and so is everything that acts for them: the MCP endpoint (`/mcp`), realtime
transcription, the OAuth sign-in and token endpoints (including refreshed tokens and token
introspection), and their personal API keys. An OAuth connection that this user authorized (for
example the Outlook add-in) is refused as well.

- Disabling a user already worked for every sign-in method and is unchanged, except that personal
  API keys now also stop working while their owner is disabled.
- A deleted user's browser no longer gets stuck. Previously the leftover session cookie made every
  request fail, including the sign-in page, until the cookie expired. The cookie is now dropped,
  and the sign-in endpoints keep working so the person can sign in again.
- If the user database cannot be read, requests now fail with a temporary "service unavailable"
  (503) instead of signing everyone out as if their accounts had been deleted.
- A user who has just signed in on one server instance is recognised by the others right away in
  clustered deployments.
- NTLM sign-in now fails when the user cannot be saved, instead of issuing a session that could
  not be used. As a result, the NTLM `allowSelfSignup: false` setting, which the old behavior
  bypassed, now takes effect: users without an account are refused.
- No other admin action is required.

## Office 365, Google Drive and Nextcloud: a Short Outage No Longer Disconnects Users

When Google, Microsoft or a Nextcloud server had a short outage, every user who made a request
while it lasted was disconnected and had to go through the sign-in again, even though their access
was still valid. Refreshing an expired access token failed, and iHub deleted the user's stored
tokens whatever the reason. Tokens are now only deleted when the provider rejects the refresh token
or none is stored.

- A network error, a 5xx or 429 from the provider, an expired or wrong client secret, and a
  provider that was disabled or removed in the meantime keep the stored tokens. The request fails
  with "temporarily unavailable. Please try again in a moment" instead of "authentication expired.
  Please reconnect your account", and access returns once the problem clears.
- The connection status shows the account as connected while access is temporarily unavailable,
  instead of "not connected".
- When an expired client secret is the cause, replacing it restores access for every user at once.
- A request that was retried after a successful token refresh and then failed for its own reason,
  such as a missing file or a rate limit, no longer deletes the tokens that were just refreshed. It
  reports that error instead of "authentication expired".
- No admin action is required.

## Markdown Chat Export Converts HTML Replies Properly

Exporting a chat as Markdown left replies that arrive as HTML (for example from an app with an HTML
output format) half-converted: links, bullet and numbered lists and headings stayed as raw HTML
tags in the `.md` file, because only bold, italic, inline code and paragraph breaks were
converted. They now come out as regular Markdown links, lists and headings. Replies that are
already Markdown or plain text are exported unchanged.

- No admin action is required — the fix takes effect automatically on upgrade.

## HTML Chat Export Shows App Name and Chat Settings as Text

Exporting a chat as HTML wrote the app name and the chat settings (model, style, output format and
the values typed into the chat's start form) into the file as markup instead of text. A value such
as `<b>x</b>` therefore showed up formatted, and a crafted value could run script when the
exported file was opened. These values are now escaped, so they appear exactly as entered, and
names containing `&` display correctly.

- No admin action is required — the fix takes effect automatically on upgrade.
