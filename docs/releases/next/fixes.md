# Fixes — Unreleased

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
