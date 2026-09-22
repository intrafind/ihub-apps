# Fixes — Unreleased

## Outlook: the document buttons under an answer work again

No document action under an iAssistant answer worked in the Outlook task pane. Two separate
reasons, neither of which said anything to the user:

- **Open in browser** and **Download** opened a popup, and popups are blocked in the task pane and
  in the browser extension's side panel: `window.open()` returns nothing, no window appears, and no
  error is raised. The click was a complete no-op, which looked like a network or proxy problem —
  it was not.
- **Preview** and **Details** fetched the document with the session cookie, which only exists in
  the browser. The task pane, the side panel and the Nextcloud embed authenticate with a token, so
  both — and the document prefill behind **Open in App** — came back unauthorized there and showed
  a load error.

Links now go out through the host — Office hands them to the default browser, the extension opens a
tab — and files are fetched on the authenticated path and saved directly, no popup involved. Every
one of these actions reports what happened: a download that fails says why (no access, no longer
available, …) on the document itself, and a link the host refuses to open says so instead of
leaving a dead button.

Two smaller corrections came with it: **Open in App**, which needs the full web app to navigate to,
is no longer offered in the embedded panels where it could not work either, and the download in the
PDF preview follows the same authenticated path as the preview itself.

## Web search now follows the user's language

Web search ran in US English far more often than it should have. Each engine decided the search
language on its own and each one got it wrong in a different way: Qwant defaulted to `en_US`,
Staan to `en-us`, and **Brave sent no language at all**, leaving it to Brave's own default. None of
them consulted the platform's `defaultLanguage`, so there was no setting anywhere that changed it.

It is now resolved once, the same way for all three: the user's language for the request, then
`defaultLanguage` from `platform.json`, then `en` only if the config cannot be read. Each provider
maps that onto its own API — Brave's `search_lang` / `country`, Staan's `market`, Qwant's `locale`
— and falls back to its own default only when the engine does not serve that language at all.

The clearest win is where no user language exists at all: **workflow and agent runs**. Those pass no
language on the tool call, so on a German install every research run was silently answered from the
US market. They now land on the configured default instead — the providers resolve it themselves, so
nothing about how a workflow renders its own prompts changes.

- Brave searches are now language-targeted at all, which they previously never were.
- A model can still override the language for a single search with the tool's `language` parameter.
- Brave results are cached per language, so one user's language is no longer served to the next.

Set the default language in **Admin → Customization → Localization** to match your install.

## `BRAVE_SEARCH_ENDPOINT` and `SEARCH_CACHE_TTL_MS` are read again

Both were documented and both were ignored. The server exposes a fixed allowlist of environment
variables plus anything ending in `_API_KEY`, so `BRAVE_SEARCH_API_KEY` worked while
`BRAVE_SEARCH_ENDPOINT` silently fell through to the hard-coded Brave URL, and a configured
search-cache TTL fell through to the built-in 10 minutes. Both are now declared, along with the
new `QWANT_SEARCH_ENDPOINT` and `QWANT_SEARCH_USER_AGENT`.

## Outlook Add-in: starter prompts no longer discard a typed note

Clicking a starter prompt such as "Generate a reply" while text was already in the chat input
replaced that text with the prompt's message and dropped it silently — on the start page as well
as inside a chat. The typed note now goes out together with the prompt's message, and the chat
shows exactly what was sent.

## Outlook Add-in: switching emails no longer shows the previous email's attachments as failed

Right after switching to another email, Outlook can still hand out the previous email's attachment
list while the new email's body is already served. The pane then listed the old attachments, each
marked "Failed", next to the new email — also on the start page. The add-in now recognises this
torn read (every attachment fetch failing with "attachment identifier does not exist") and reads
the email again after a short pause.

## Dollar signs inside message text are no longer altered

Text inserted into an app's prompt template — an email body, a pasted document — could change on
the way to the model: `$&`, `$'`, `` $` `` and `$$` were treated as replacement patterns when
`{{content}}` was filled in, so an email quoting "$$" arrived with a single dollar sign. The
inserted text now reaches the model exactly as written; only the template's own placeholders are
expanded.

## iFinder: the private key field now actually takes effect

Pasting a key into Admin > Integrations > iFinder's "Private Key (PEM)" field saved it to a spot
the JWT-signing code never read, so the integration kept failing with "iFinder private key not
configured" even right after saving — and setting the `IFINDER_PRIVATE_KEY` environment variable,
as the error suggested, didn't help either, because the server ignored that variable too. Both are
fixed:

- The private key field is now a credential picker backed by Admin > Credentials, the same
  encrypted-storage picker already used for Jira, OIDC and LDAP secrets.
- The `IFINDER_PRIVATE_KEY` environment variable is read correctly, for setups that prefer it over
  a stored credential.
- Any key previously pasted into the old field is moved into a credential automatically on
  upgrade, and the "Test iFinder" connection check no longer reports the environment variable as
  available when the key it would actually sign with is still missing.

## Chat: the Web Search switch can be operated with the keyboard

In the chat input's "+" menu, the Web Search switch could be reached but not turned on or off
without a mouse — arrow keys, Space and Enter all did nothing, so keyboard and screen-reader users
had no way to run a web search. The switch now behaves like the tool switches below it: arrow keys
move to it, Space or Enter toggles it, it shows a visible focus ring, and assistive technology
announces it as a checkable menu item with its on/off state (WCAG 2.1.1 Keyboard, 4.1.2 Name, Role,
Value).

## Proxy: one bad URL pattern or a list-shaped bypass list no longer disables proxying

Two ways of writing a valid-looking `proxy` block stopped the proxy from being used at all, with
nothing in the log to say so:

- A `urlPatterns` entry that is not a valid regular expression aborted the check for every entry
  after it — and a bad entry in first position meant no URL ever matched, so everything went
  direct. Each pattern is now compiled on its own; a bad one is skipped with a warning naming it
  and the rest still apply.
- Writing `noProxy` as an array (`["localhost", ".local"]`) — the shape the neighbouring
  `ssl.domainWhitelist` uses — made every bypass fail, so hosts meant to go direct were sent
  through the proxy. Both the array and the comma-separated string are now accepted.

An `${ENV_VAR}` placeholder left in `proxy.http` or `proxy.https` is also no longer used as if it
were a proxy address when the variable is not set; the connection goes direct instead of failing
on an unparseable URL.

## LDAP and NTLM users are stored under their directory login name

A user signing in through LDAP or NTLM was created in **Admin → Users** with their email address
as the account name, not the login name the directory knows them by — `sAMAccountName` for Active
Directory, the Windows account for NTLM. Only users with no email in the directory got the right
one, and re-signing in never corrected it, because nothing wrote the field again after the account
was created.

The login name was available the whole time and everything else used it: the session, the groups
and the tokens iHub mints were all correct. Only the stored record disagreed, which is why this
went unnoticed until something read it — the account name shown in the user list, and the admin
user editor, which refused to open such a record at all because `@` is not valid in a username.

Existing records are repaired on upgrade by migration V115, which recovers the login name the
directory already recorded alongside each account. It leaves a record alone where the rewrite would
not be unambiguous: accounts that also sign in locally, where the account name is a credential
somebody types, and accounts whose login name another user already holds. Those are listed in the
startup log with the duplicate to resolve. Anything it skips still heals by itself the next time
that user signs in.

## iAssistant conversations are no longer cancelled after 60 seconds

A long iAssistant interaction — the workspace profile especially — was cut off mid-answer after a
minute.

The cause was a transport ceiling meant for a different shape of model. `llm.streamIdleTimeoutMs`
bounds the gap between two chunks of a stream, and 60 s of silence from a model emitting tokens
steadily really is a hang. An iAssistant turn is not that: it assesses what it knows, plans,
searches, reassesses and only then starts writing, and iFinder's own per-turn budget defaults to
90 s *before* generation begins. The quiet stretch before the first word was ordinary work, and the
ceiling read it as a dead stream.

The `iassistant-conversation` models now carry `streamIdleTimeoutMs: 180000` of their own. Every
other model keeps the installation-wide default.

Two related traps went with it:

- **`iAssistant.timeout` is removed.** It was documented as the request timeout for iAssistant API
  calls, defaulted to 60000, and nothing read it — so it is exactly what an admin hitting this
  would reach for, and raising it changed nothing. Migration V117 removes it and warns if yours had
  been tuned.
- **`REQUEST_TIMEOUT` is gone from `config.env`.** That file shipped `REQUEST_TIMEOUT=60000`, which
  overrode the code's 5-minute whole-call deadline with one minute for every binary deployment that
  copied it. `config.env` is now marked deprecated: it applies only to the single-executable
  distribution, and settings belong in `platform.json` or a `.env` file.

## A stopped iAssistant generation no longer hangs the chat

Deleting the message an iAssistant turn was answering left the turn spinning until a timeout fired.
The Conversation API signals this with a `generation_stopped` event, which the adapter had no case
for — so the stream never completed. It is now treated as the terminal event it is.

## One loading indicator instead of two

An iAssistant message in progress showed two animations at once: the phase indicator ("Analyzing
current knowledge") with its own animated dots, and the generic three-dot pulse underneath it. The
generic one is now the fallback it was meant to be and stands down whenever a phase is showing.

## App-level iAssistant settings that silently did nothing

`iassistant.tools`, `iassistant.labels`, `iassistant.scope` and `iassistant.ephemeral` were read by
the adapter but missing from the app schema, so validation stripped them at load with no error —
setting any of them on an app did nothing at all. `tools` was the costly one: it meant an app could
not enable `ifinder_search` for itself, only the model could.

They are declared now and work as documented. If an app already carries any of them, check it: they
now actually apply.

## Multi-worker mode no longer duplicates startup jobs, and a halted migration now actually halts

Under the default clustered setup (`WORKERS=4`), every worker independently ran the hourly usage
rollup, the daily audit-log cleanup, and an eager connection pass to configured MCP servers on
startup — so those jobs wrote the same rollup and audit-log files on independent timers, and MCP
servers saw several times the expected number of connections. Only one worker now runs these
startup jobs; the rest keep serving requests normally and still connect to MCP tools on first use.

Two related startup fixes:

- The configuration-migration lock is now created atomically instead of checked-then-written,
  closing a narrow window where two server processes starting at the same instant could both
  believe they had acquired it and migrate concurrently.
- A migration failure while `migrations.onFailure` is `"halt"` (the default) used to be logged as
  an error but the server started anyway; it now stops the server from starting instead of serving
  requests against configuration a migration never finished updating.

A related request-time fix: opening a short link (`/s/:code`) right after it was created could
answer "Not found" if the redirect landed on a different worker than the one that created it —
each worker cached usage.json/shortlinks.json in memory from when it started and never looked at
the file again. A worker now re-reads the file the moment it is asked for a code it does not
recognise, so a link works on every worker as soon as it exists. The admin usage endpoint
(`/api/admin/usage`) is similarly refreshed on every request instead of showing whichever worker's
stale in-memory snapshot happened to answer.
