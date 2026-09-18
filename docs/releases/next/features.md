# Features — Unreleased

## The default language is configurable in the admin UI

**Admin → Customization → Localization** is a new page for the installation's default language.
It was previously only reachable by hand-editing `contents/config/platform.json`, which meant the
setting effectively did not exist for most admins.

The dropdown offers the languages this installation actually has translations for — the same set
the language switcher shows end users — so it is not possible to select a language with nothing
behind it. The change applies immediately; no restart is needed.

The default language decides more than the interface:

- the interface language for users who have not chosen one,
- the language **web search** runs in when a request carries none of its own, which is every
  workflow and agent run,
- the fallback for any text with no translation in the requested language.

It does not change the language a workflow renders its own prompts in — that follows the run, not
this setting.

## Web search with staan.ai

`staanSearch` is a third script-backed search engine alongside `braveSearch` and `qwantSearch`,
using the [staan.ai web search API](https://docs.staan.ai/docs/web-search). It fills the gap
between the two that were already there: Brave needs a paid subscription, and Qwant — the keyless
option — is fronted by DataDome, which answers requests from data-centre IP ranges with a captcha.
An install on cloud hosting therefore had exactly one working choice, and it cost money. Staan
needs an API key but answers from anywhere.

- Select it per app in **Admin → Apps → Edit App → Web Search** as the **Staan** provider, or
  leave the provider on **Auto**.
- Configure the key in **Admin → Providers → Web Search Providers → Staan Search**, or set
  `STAAN_API_KEY` in `config.env`. Keys entered in the admin UI are encrypted at rest.
- **Auto** now means: Brave when a Brave API key is configured, then Staan when it has one, and
  Qwant otherwise. An install that already had a Brave key keeps using Brave and is unaffected.
- The connectivity test under **Admin → Providers** covers Staan too, and distinguishes a rejected
  key from a rate limit, a malformed request and a proxy that swallowed the response.

Two things Staan does that the other engines do not:

- **Domain scoping.** `includeDomains` restricts a search to a set of sites and `excludeDomains`
  keeps results away from them (10 domains each, and the two cannot be combined). The `site:` and
  `-site:` query operators work as well.
- **More than ten results.** Staan serves ten per request, so asking for more pages through
  further requests, up to 40. `maxResults` above 10 is honoured rather than silently truncated.

Results come back in the same shape as Brave's and Qwant's, so an app can be switched between
engines without the model seeing a different tool. Search language follows the app as usual: Staan
serves the German, French and English markets, and an unsupported region falls back to a supported
one for the same language.

## Web search providers can be tested from the admin UI

**Admin → Providers → Web Search Providers** gained a **Connectivity** column and a **Test**
button that runs one real search and reports what happened. **Test All** now covers web search
providers as well as LLM providers, and each provider's own page has a **Connectivity Test**
card with an optional custom query, so a configuration can be saved and checked in one place.

This exists mainly for Qwant. Qwant's API sits behind DataDome, which answers requests from
data-centre IP ranges with a captcha instead of results — so a perfectly configured provider can
still be unusable, depending only on where the server sends its traffic from. Reported as a bare
HTTP 403 that is indistinguishable from a broken setup, and an admin goes looking for a setting
that does not exist.

- A blocked provider is labelled **Blocked**, not *Failed*, and the panel says in as many words
  that this is not a configuration problem and that retrying will not help.
- Each verdict comes with concrete next steps — change egress IP, use Brave, fix the key, check
  the proxy — rather than a raw error string.
- The panel shows the endpoint and the egress route actually used (outbound proxy, or direct),
  since that is what decides whether bot protection triggers.
- Missing and rejected API keys, rate limiting, transport failures and "answered but no results"
  are each reported distinctly instead of collapsing into one failure.
- Every test issues a live request and **bypasses the result cache**, so it reports the
  provider's behaviour now rather than replaying an earlier success.

## Web search without an API key: Qwant joins Brave

Web search no longer requires a paid search subscription. `qwantSearch` is a second
script-backed search engine alongside `braveSearch`, using Qwant's public API — no key, no
account, no per-query cost — and returning the same result shape, so an app can switch between
the two without the model seeing a different contract.

- **Admin → Apps → Edit App → Web Search → Provider** now offers *Qwant (no API key)* next to
  *Auto* and *Brave*.
- **Auto** now means what it says: Brave when a Brave API key is configured, Qwant otherwise.
  An install with no Brave key previously offered the model a search tool that failed on every
  call with "Brave Search API key is not configured"; it now searches. Installs that have a
  Brave key are unaffected.
- A named provider is always honoured as configured, so an error names the engine the admin
  actually chose.
- **Admin → Providers** lists *Qwant Search* under Web Search Providers marked
  "No API key required", instead of the "Not Configured" warning that reads as broken when
  there is nothing to configure.
- Results can be localised per search (`en`, `de`, `de-CH`, …) and carry a publication date
  where Qwant reports one.

**Before enabling it, check the server's egress IP.** Qwant's API sits behind DataDome, which
answers requests from data-centre IP ranges with a captcha rather than results — so on many
cloud VMs Qwant is blocked no matter how it is configured. That case now reports
`QWANT_CAPTCHA` with an explanation instead of a bare HTTP 403, and
`node tests/manual/manual-test-qwant-search.js` answers the question for a given host in one
command. Where Qwant is blocked, configure Brave Search.

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
- The page opens on what is actually happening: routed through a named proxy, no proxy in use, or
  switched off. A fresh installation is in the second state — no `proxy` block is written to
  `platform.json` and nothing is proxied until a URL is set here or `HTTP_PROXY`/`HTTPS_PROXY` is
  set in the environment. The switch on its own proxies nothing; turning it off forces every
  request direct, environment variables included.
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

## Feedback: one admin page, and a switch to turn it off

Response feedback — the star rating under every AI answer — is now something you configure and
review in one place, **Admin → Feedback**, and something you can switch off.

- **Settings** holds the whole feature: collection on or off platform-wide, a per-app list that
  takes single apps out, whether submitted feedback is stored (`feedbackTracking`) and how the
  person who gave it is recorded (`usageTrackingMode`, shared with usage tracking). What each
  switch does, and where it stops, is written next to it.
- **Feedback** holds the review that used to sit under Usage Reports → Feedback: the rating
  distribution, the breakdowns per user, app and model, and the individual entries with their
  comments. Usage Reports keeps its average-rating tile, which now links here.
- Switching collection off hides the rating and the comment dialog in every chat surface — main
  chat, compare mode, canvas and the Office add-in — and makes `POST /api/feedback` answer
  `403 FEATURE_DISABLED`, so it cannot be submitted by calling the API either.
- A single app opts out with **Response Feedback** in the app editor, the per-app list on the new
  page, or `"features": { "feedback": false }` in its configuration. The platform switch still has
  the last word.
- The same platform switch also appears under **Admin → Features → Content**; both read and write
  one stored value.

Everything defaults to enabled, and feedback submitted earlier stays readable whatever the switches
say. Storing feedback (`feedbackTracking`) stays independent of showing the rating — turning one off
does not turn the other off.

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
