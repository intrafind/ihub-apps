# Fixes — Unreleased

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

## Dollar signs inside message text and sources are no longer altered

Text inserted into an app's prompt template could change on the way to the model: `$&`, `$'`,
`` $` `` and `$$` were treated as replacement patterns wherever a value was substituted into a
`{{placeholder}}`, so a dollar sequence in the source text came out altered instead of verbatim.
This is now fixed everywhere a template value is inserted; only the template's own placeholders
are expanded, never anything inside the values themselves.

- **Message text:** an email body or pasted document inserted at `{{content}}` — for example an
  email quoting "$$" used to arrive with a single dollar sign.
- **Knowledge sources:** document, web page, or iFinder content inserted at `{{sources}}` /
  `{{source}}` could be altered the same way; that content now reaches the model unchanged even
  when it contains a `$1`- or `$&`-shaped sequence.

## A variable name with special characters no longer crashes the chat request

An app's prompt template can carry variables sent from the client or defined by an admin. A
variable name containing a regex-special character — an unmatched `(`, `[`, or similar — made the
whole chat request fail with a server error instead of just substituting that one variable. Such
names now substitute correctly like any other variable name.

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

## Chat: the copy-options menu now follows dark mode and stays on top

The small arrow next to a message's copy button opens a menu with "as Text", "as Markdown" and "as
HTML". That menu stayed a hardcoded white panel with dark gray text regardless of the active
theme, so on a dark background it showed up as a bright, low-contrast block — most noticeable in
the Outlook add-in, which offers its own Light/Dark/Automatic appearance setting. It also sat below
the neighbouring "Insert" menu in stacking order, so in a narrow window it could end up hidden
behind it, and had no width limit, letting it grow past the edge of a narrow pane.

The panel now follows the theme like the rest of the message actions, always renders above
neighbouring menus, and is capped to a fixed width.

## Admin: the model "Test" button and its result messages are translated again

The "Test" action on Admin > Models and Admin > Providers showed a broken label instead of
"Test"/"Testen", because the translation file defined `admin.models.test` as a group of
sub-messages rather than as the button's own text. The result headline shown after a test (e.g.
"Connection timeout", "Authentication failed") was also always displayed in English, regardless of
the admin's language. Both the button label and the result messages now follow the selected
language.

## Outlook Add-in: the document buttons on a citation work again

In the Outlook task pane and the browser-extension side panel, the "Open in browser" and
"Download" buttons on a cited document did nothing at all — no window, no file, no error. Those
hosts block pop-ups, and the buttons opened the document in one; the same buttons worked in the
browser, which made it look like a network or firewall problem. They now use the host's own
mechanism instead: Outlook opens the link in the user's browser, the side panel opens it in a new
tab, and the web app is unchanged.

- Downloads are fetched over the signed-in connection and saved as a file, so they also work in
  the add-in, where the previous link carried no session and would have been rejected.
- The document preview and its Details dialog load over the same connection, for the same reason.
- When an action cannot be carried out, the citation list now says so instead of leaving a button
  that appears to do nothing.
- "Open in App" is hidden in the add-in and the side panel, where there is no app page to open.

## Outlook Add-in: replies keep every recipient, and inserts keep your signature

Answering a thread from the task pane quietly reduced it to a reply to the sender: every other `To:`
recipient and all `CC:` recipients disappeared from the draft. The pane only ever opened a
reply-to-sender form — there was no reply-all path at all — so a thread answer reached one person
instead of the group. **Reply all** is now a real action and is what the button does by default.

Inserting an answer into an email you were already writing also replaced the draft's body outright,
which took the Outlook signature and the quoted thread with it — a compliance problem wherever a
footer is mandatory. The answer is now written into the draft at the cursor, leaving the signature
and the quoted thread untouched.

- Outlook still suppresses the automatic signature on a *new* form an add-in fills in — a platform
  limitation with no add-in-side workaround. Where every mail must carry a footer, keep the default
  answer action on **Insert into draft**, or apply the footer with a mail-server transport rule.
  
## Chat can no longer reach AI models outside a user's group permissions

A group's **Models** allowlist (Admin → Groups) only ever controlled which models an app's model
picker displayed. The chat request itself never checked it, so a user could still reach a model
outside their group's allowed models — either by asking for it directly, or simply by using an app
whose preferred or default model fell outside their allowance, silently and with no indication a
restricted model had been used.

Chat requests are now checked against the requesting user's group-level model permissions, the same
way `/api/models` and the OpenAI-compatible API already are:

- Asking for a model outside your group's allowed models now fails clearly instead of silently
  using a different one.
- Automatic model selection — an app's preferred or default model — now only ever considers models
  both the app and your group allow.

No admin action is required: groups that already restrict **Models** to specific entries are now
fully enforced for chat, including apps invoked as tools through the MCP gateway.

## Transient server errors no longer get cached and served back as real data

A single failed request to the server — a brief 5xx while loading something like UI styles or
platform configuration — could get cached in the browser and served back as if it were successful
data for up to a minute, so the affected screen crashed or rendered blank instead of showing an
error or simply retrying. Failed requests are no longer written into the client-side response
cache, so a retry after a transient error always fetches fresh data instead of replaying the
earlier failure.

## vLLM: tools with a parameter named `title` or `format` work again

On vLLM models, a tool whose parameter was literally named after a JSON Schema keyword — `title`,
`format`, `exclusiveMinimum` or `exclusiveMaximum` — had that parameter silently removed from the
schema sent to the model, while the schema still listed it as required. The model then either
rejected the request or called the tool without ever being told the parameter existed. MCP tools
are the common case, since a `title` or `format` field is ordinary in tool definitions generated
from JSON Schema.

vLLM still drops those keywords where they are genuine schema annotations; it no longer confuses a
property's *name* with one.

## Outlook Add-in: the chat no longer resets on its own and loses answers

The task pane sometimes cleared the whole conversation — including finished answers and a
half-typed message — while users were still reading the same email. Any selection change in the
message list (re-selecting the message, a list refresh when new mail arrived) counted as "opened a
different email".

- The chat now starts over only when a genuinely different email is opened, and never while an
  answer is still being generated.
- When it does start over, a **Restore previous chat** notice brings the earlier conversation and
  the typed text back.
- Removed attachments and the email-body opt-out in the context strip stay as set while the same
  email remains open.

## Outlook Add-in: answers about an email no longer say "Based on external knowledge"

Summarizing an email that has attachments labelled the answer "Based on external knowledge"
("Basierend auf externem Wissen"), although everything came from the user's own mailbox. Email
plus its attachments now shows **Based on email and attachments**, and answers that really combine
several sources say **Based on multiple sources** instead of "external knowledge".
