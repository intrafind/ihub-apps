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
