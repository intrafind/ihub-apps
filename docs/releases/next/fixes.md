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

The clearest win is where no user language exists at all: **workflow and agent runs**. Those had no
language on the tool call, so on a German install every research run was silently answered from the
US market. Workflow runs now carry the run's language into their tool calls, and the workflow
engine takes its own default from `platform.json` instead of a hard-coded `en`.

- Brave searches are now language-targeted at all, which they previously never were.
- A model can still override the language for a single search with the tool's `language` parameter.
- Brave results are cached per language, so one user's language is no longer served to the next.

Set `defaultLanguage` in `contents/config/platform.json` to match your install. It has no admin UI
yet, and a change takes effect on server restart.

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
