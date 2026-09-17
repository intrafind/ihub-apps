# Features — 5.4.19

## OAuth Login for MCP Clients No Longer Fails With "Authorization code is invalid or expired"

Fixed a bug that made the OAuth 2.0 authorization code flow fail on any multi-worker deployment
(the default is 4 workers). After approving the consent screen, clients such as Claude Code
reported `Authorization code is invalid or expired` and never obtained a token.

- Authorization codes were held in a single worker's memory. Since connections are distributed
  across workers round-robin, the token request almost always arrived at a different worker than
  the one that issued the code, which then could not find it. Codes are now resolved across
  workers, so the exchange succeeds regardless of which worker handles each request.
- Codes remain strictly single-use: a code is consumed on exactly one worker, so replay attempts
  are still rejected cluster-wide with `invalid_grant`.
- The consent screen no longer depends on server-side session state either. Previously the CSRF
  token and the PKCE `code_challenge` were stored in a per-worker session, so approving consent
  could fail with `CSRF token missing`, or could issue a code with no PKCE binding that the token
  endpoint later rejected.
- Consent parameters (`redirect_uri`, `scope`, `code_challenge`, `nonce`) are now cryptographically
  signed and verified on submission, so they can no longer be altered between the consent screen
  and the decision.
- No configuration changes are required. Deployments that set `STICKY_SESSIONS=true` to work around
  this no longer need it for OAuth.

## Connection Diagnostics for iFinder and iAssistant

The **Test iFinder** and **Test iAssistant** buttons under Admin → iFinder Integration now run a
step-by-step diagnostic instead of returning a single pass/fail message. Each step reports what it
observed and, when it fails, what to check — so connecting iHub to iFinder no longer requires
reading server logs and guessing.

- Checks the whole path: the configured URL (including a warning when the hostname is not fully
  qualified), DNS resolution, the TCP/TLS handshake with certificate subject, issuer, expiry and
  trust result, JWT generation, local signature verification, JWKS reachability, and a real API
  request against iFinder's search endpoint or iAssistant's profile list.
- Shows the decoded JWT — header, payload, and the subject that was actually derived for the user —
  so it can be compared against the trust configuration on the iFinder side. A 401 now also surfaces
  the `WWW-Authenticate` header and names the usual causes: issuer mismatch, a `kid` missing from
  the JWKS, a subject in the wrong format, or clock skew.
- Flags the issuer and JWKS URL that **iFinder itself must call back to**. A `localhost` or
  single-label hostname there is reported as a failure, because iFinder can never fetch the signing
  keys from it — the most common reason iFinder answers 500 during token validation.
- Detects an iAssistant profile ID that does not exist and lists the profiles the tested user can
  actually see.
- Diagnostics options allow testing as a specific user (email, username, domain) to verify how the
  JWT subject is built, optionally returning the signed JWT together with a ready-to-run `curl`
  command, and running an iAssistant conversation round-trip to verify write access. Without the
  token option the `curl` command references `$TOKEN` and is safe to share.
- The search term and profile are fixed rather than configurable per run, so no value from the
  request can influence which URL iHub contacts. The diagnostics always exercise the configured
  search profile, which is what an admin wants to verify anyway.
- A previous behaviour is fixed: an iAssistant network failure used to be reported as "configuration
  is valid" and counted as a success. Unreachable now reads as unreachable.
