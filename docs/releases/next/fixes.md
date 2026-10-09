# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.

## Deleting a User Now Ends Their Session, for Every Sign-In Method

Deleting a user who signed in through OIDC, LDAP, Microsoft Teams or NTLM did not cut off their
access: they kept using iHub with their existing session until it expired (8 hours by default,
longer if the session timeout was raised). Only deleted local (username/password) accounts were
signed out at once. A deleted user is now refused on their next request, whichever way they
signed in, and so is everything that acts for them: the MCP endpoint (`/mcp`), realtime
transcription, the OAuth sign-in and token endpoints (including refreshed tokens and token
introspection), and their personal API keys. An OAuth connection that this user authorized (for
example the Outlook add-in) is refused as well.

- Disabling a user already worked for every sign-in method and is unchanged, except that personal
  API keys now also stop working while their owner is disabled.
- A deleted user's browser no longer gets stuck. Previously the leftover session cookie made every
  request fail, including the sign-in page, until the cookie expired. The cookie is now dropped,
  and the sign-in endpoints keep working so the person can sign in again.
- If the user database cannot be read, requests now fail with a temporary "service unavailable"
  (503) instead of signing everyone out as if their accounts had been deleted.
- A user who has just signed in on one server instance is recognised by the others right away in
  clustered deployments.
- NTLM sign-in now fails when the user cannot be saved, instead of issuing a session that could
  not be used. As a result, the NTLM `allowSelfSignup: false` setting, which the old behavior
  bypassed, now takes effect: users without an account are refused.
- No other admin action is required.
