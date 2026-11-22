# Fixes — Unreleased

## Thinking models no longer fail as "endpoint unreachable"

Gemini models with a large prompt or a high thinking level, and image models, could fail with
"could not be reached: it did not answer the connection attempt" although the endpoint was fine.
The connect timeout also counted the time the model thought before its first chunk, because
Google sends no response until then.

- The connect timeout (`connectTimeoutMs`) now covers only establishing the connection: DNS, TCP,
  TLS, or the proxy tunnel. Waiting for the model's first chunk falls under the overall request
  deadline.
- A raised `connectTimeoutMs` on a model, added only to keep a slow model from timing out, is no
  longer needed and can be removed.
- The error now reads "Could not connect to provider … within N ms".

## Chat: A Long Answer Also Survives a Failed Status Check

When the browser gets no reply to a chat message, because the answer takes longer than five minutes
or a reverse proxy answers 502 or 504 first, it asks the server whether the answer is still being
worked on. If that one check failed too, the answer ended in the browser with an error, although
the server went on and finished it: "Request timed out. The operation may have taken longer than
expected." after five minutes, "A server error occurred. Please try again later." after a 502 or
504.

- The check is now repeated after 1, 2 and 4 seconds before an error is shown. A check that gets no
  answer within 5 seconds counts as failed, so the error appears after 27 seconds at the latest.
- An answer whose start the browser has already received is kept on screen whatever the check says.
- The text "Request timed out. …" follows the language of the user interface; it was English in
  every language.

No action is needed after the upgrade.

## A Question or Approval Card No Longer Takes the Focus While You Type

When the assistant asked a question or asked for approval of a tool call while you were typing
somewhere else, for example in the app search (Ctrl+K), the card moved the keyboard focus to itself
and the next keys landed in the card. At the end of an answer the chat input also took the focus
back from wherever it was.

- A card that appears while you type, or right after you pressed a key or clicked, leaves the focus
  where it is. A screen reader announces it instead ("Approval needed: …", "The assistant asks:
  …"). When you are not typing, the card takes the focus as before.
- Enter in the chat input never answers a card.
- At the end of an answer the chat input takes the focus back only when nothing else has it.
- The question card is part of the chat, not a dialog: Tab moves on past its last control instead
  of going round inside the card.
- The notice of a scheduled run that waits for your approval stays until you close it; the other
  notices still close by themselves after 12 seconds.

## An App Call Without Resolved Permissions Is Refused

An app that calls another app as a tool, an MCP `tools/call` of an app and an A2A task of an app
run only for a caller whose permissions are resolved and whose groups grant the app. Before, a
caller that carried no resolved permissions (an internal or hand-built principal rather than a
signed-in user) could call any app as a tool, including apps no group of it grants.

- Such a call now answers "You do not have permission to access app …" and no model is called.
- A refused app call, and a tool call refused because the caller may no longer use the tool (an
  installation that was disabled or a group grant that was withdrawn after the tools were
  listed), is written to the audit log: action `execute`, resource `app` or `tool`, result
  `failure`.
- Signed-in users, personal API keys and OAuth clients keep the access their groups and clients
  give them; nothing changes for them.
