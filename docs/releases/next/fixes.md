# Fixes — Unreleased

## Outlook Add-in: Switching emails shows the new email once, and always

Clicking a different email made the task pane refresh twice: first with the previously open email,
then with the new one. Sometimes it stopped at an empty "Email context" header with no email text.
Outlook reports a change in the message list before it opens the new email, and can keep naming the
previous email for a moment after it has switched, so a read at the wrong moment returned the old
email or nothing. The pane now decides from what it actually read: a selection change is read in the
background and only replaces the shown email when the read really returned a different one, and a
read that still returned the previous email, or no email, is checked once more shortly after.
Re-selecting the open email or a refresh of the message list changes nothing on screen.

## Usage Reports: Token counts come from the provider

Usage reports showed estimated prompt tokens for every chat message, and for streamed answers from
OpenAI and OpenAI-compatible servers (vLLM, local models) estimated completion tokens as well.
vLLM models never contributed provider numbers at all. The provider's counts arrive in a last
message after the answer, which was never read, and prompt tokens were counted locally before the
call. Reports now use the provider's numbers wherever it sends them.

- Prompt-token totals shift after the upgrade, usually upwards: the local estimate was approximate
  and left out tool definitions and attachments.
- Prompt tokens mean the same for every provider: the whole input, cached tokens included.
  Completion tokens are the whole output — Gemini thinking tokens, which Gemini bills as output,
  now count too.
- **Data Quality** on the usage overview moves towards "Provider" as new usage comes in.
