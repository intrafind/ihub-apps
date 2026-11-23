# Fixes — 5.7.3

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
