# Features — Unreleased

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
