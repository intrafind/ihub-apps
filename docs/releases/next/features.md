# Features — Unreleased

## Outlook Add-in: the model sees who wrote the email and what you told it to do

The task pane now sends the open email as one structured block — sender, recipients, date,
subject, the signed-in mailbox user and the body — followed by the note you typed in a separate
`<user_instruction>` block. Until now the note was glued in front of the raw email text with no
label, so models regularly read it as one more quoted paragraph and answered the thread instead of
following the note — for example committing you to a task you had just assigned to a colleague.

- Sender, To, Cc, date and subject are read from Outlook and included even when the body is
  excluded; the greeting no longer has to be guessed from the quoted thread.
- Your note always comes last, right where the app's prompt continues.
- Collected emails and calendar items use the same tagged shape; the browser extension sends the
  page as `<current_page>` with its title and URL.
- A fixed `<context_rules>` note marks the blocks as quoted material, and the add-in's own tag
  names inside email text are escaped, so an email cannot close a block early or smuggle in a fake
  `<user_instruction>`.

## New app: Outlook – Reply Directly

A reply-drafting app built for the Outlook task pane ships as a default app (`outlook-reply`). It
produces only the insertable reply body, answers in the language of the email, signs with the
user's profile name and treats the note typed into the chat as the content of the reply — a request
in the email is never confirmed unless the user says so.

- Starter prompts: Generate a reply, Say thanks briefly, Politely decline
- Works with a typed note alone, a starter prompt alone, or both together
- Knows today's date and the signed-in user, so it can tell whether a deadline in the email has
  passed and which messages in the thread are the user's own
- Recommended as the default chat app of the task pane's start page

## Configure and test the outbound proxy from the admin UI

The proxy iHub uses to reach LLM providers, web search, Jira, OIDC and MCP servers is now a
setting like any other, under **Admin → Security → Outbound Proxy**. Until now it could only be
changed by hand-editing `contents/config/platform.json` or the environment, with nothing in the
product to confirm the change had landed.

- Switch proxying on or off, set the HTTP and HTTPS proxy URLs, maintain the bypass list and the
  selective-proxy URL patterns — invalid regular expressions are flagged as you type and refused
  on save, naming the offending entry.
- Each field says whether the value in effect comes from `platform.json` or from the environment,
  and an `${ENV_VAR}` placeholder that no variable resolves is called out instead of silently
  doing nothing.
- **Test connectivity** probes any URL against the settings on screen, saved or not. It reports how
  the URL is routed (through the proxy, bypassed, excluded by a pattern, or direct), whether the
  proxy itself answers, the HTTP status and how long each step took, and — when it fails — what
  went wrong and what to check next: proxy unreachable, proxy authentication required, DNS,
  TLS, timeout or an error from the target itself. Redirects are not followed and no response body
  is fetched.
- Proxy passwords are encrypted at rest and shown as `***REDACTED***`; leave the mask in place to
  keep the stored password, or type a new one to replace it. They no longer appear in the server
  log either.
- The bypass list accepts both forms admins reach for: `"localhost,.local"` and
  `["localhost", ".local"]`.

Changes take effect immediately — no restart.

## Govern the MCP clients that connect through a metadata document

Claude identifies itself to the MCP gateway with a metadata document it publishes, which until now
left administrators with one lever for all of them: the trusted-host list. Claude web, Claude
Desktop, Claude Code and Cowork all publish under `claude.ai`, so "only this group may use Claude
Code" was not expressible, and there was no way to cut one of them off. **Admin → OAuth → Clients**
now lists each of them as a real row — kind badge, document URL, connection count, first seen, last
used — with actions of its own.

- **Block** a client. Its connections are revoked in the same action, and nobody can reconnect
  until it is unblocked. An access token already issued keeps working until it expires, which the
  confirm dialog states.
- **Revoke all connections** clears every consent and every refresh token that one client holds,
  across all users, in one action — on the Clients page and on **Admin → OAuth → Connections**.
- **Edit policy** per client: allowed groups, apps, models, prompts, grantable scopes and token
  lifetime. Each field either applies to that client alone or inherits the global default under
  **Admin → MCP gateway → Client identification**, field by field, so narrowing one client's groups
  leaves its neighbours on the same host untouched.
- **Blocked client hosts**, beside the trusted-hosts field, refuse a whole vendor without editing
  the list you want to keep — and before this server makes any request on its behalf.
- Identity stays where it was: a client's name, redirect URIs and grant types are still read from
  the document it publishes on every authorization and never stored, and no client can be marked
  trusted or exempted from the consent screen.

Policy is now re-checked on the request path, not only at the consent screen. Blocking a client,
narrowing its groups or taking a user out of one takes effect on the next gateway request — at most
one access-token lifetime — instead of waiting for an administrator to revoke each connection by
hand. Narrowing a client's grantable scopes narrows connections that already exist at their next
token refresh, and a **local** user's group membership is re-read from the user store on every
refresh. Group membership held by an external identity provider still updates at the user's next
interactive sign-in; **Admin → OAuth → Connections** is the immediate remedy there.

Every action is audited: clients discovered, approved, blocked, unblocked, their policy changed,
and connections revoked in bulk with the client and the count.
