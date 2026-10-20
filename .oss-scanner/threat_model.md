<!-- Threat model for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner). -->
# Threat model

## What this project does and where untrusted input enters

iHub Apps is a self-hosted platform for building and running AI-powered chat apps
on top of multiple LLM providers, with retrieval (RAG), tool/MCP integrations, and
an admin configuration UI. Untrusted input arrives through:

- HTTP requests from browser clients: chat messages, file uploads, and (for
  privileged users) app/model/tool/platform configuration submitted through the
  admin API.
- Identity claims from configured auth providers (OIDC, LDAP, NTLM, reverse-proxy
  headers) — these are asserted by a third party and must be validated, not
  trusted blindly.
- Responses from configured LLM providers, MCP servers, and external tools, which
  are fed back into later model context and can contain adversarial content
  (indirect prompt injection).
- Content fetched from configured external sources (web pages, iFinder,
  Confluence, SharePoint, cloud storage, etc.) that is retrieved into chat context.

Treat all of the above as untrusted, including content that originates from an
authenticated-but-low-privilege user and later reaches an admin or another user.

## Components that matter most / least

Highest priority:

- `server/middleware/authRequired.js`, `server/utils/authorization.js` — access
  control and group-permission resolution (`groups.json` inheritance).
- `server/routes/admin/**` — the highest-privilege HTTP surface; any way for a
  non-admin or anonymous caller to reach it is critical.
- `server/services/TokenStorageService.js`, `server/configCache.js` — AES-256-GCM
  encryption of secrets at rest (Jira, OIDC, LDAP, NTLM, cloud storage) and the
  `contents/.encryption-key` handling.
- Auth provider implementations in `server/routes/auth.js` (OIDC, LDAP, NTLM,
  proxy-header auth) — token/signature validation, session handling.
- MCP/tool execution paths and anything that builds shell commands, file paths,
  or URLs from user- or model-supplied values.

Lower priority / mostly out of scope:

- The client build output and `node_modules` — generated/vendored, not reviewed.
- The mdBook/Rust documentation site under `docs/` — not built or shipped by
  `.oss-scanner/Dockerfile` (`npm run build:docker` explicitly skips it).
- Example/demo content under `contents/` — ships only to make local
  getting-started easier, not a security boundary.

## How to exercise it

- `npm run dev` starts the server and client with hot reload.
- `npm run test:quick` (run during the scanner's image build) exercises unit and
  integration-style tests across auth, config, tools, MCP, and the admin routes.
- Full integration/E2E suites (`npm run test:integration`, `npm run test:e2e`)
  need a browser and external services, so they are not run during the build.

## How you rate severity

- **Critical**: authentication/authorization bypass (reaching admin routes or
  another user's data without the right permissions), disclosure of secrets
  (API keys, the encryption key, decrypted credentials), or RCE.
- **High**: broken access control that requires some precondition (e.g. a
  specific group misconfiguration), path traversal or arbitrary file
  read/write in config or content storage, SSRF from server-side fetches
  (sources, tools, cloud storage).
- **Medium**: stored/reflected XSS that requires an authenticated session,
  denial-of-service that needs authentication or significant resources to
  trigger, information disclosure that doesn't expose secrets.
- **Low**: issues needing an already-privileged attacker (e.g. an existing
  admin) to gain little beyond what that role already has.

Broken access control (OWASP A01) is the most common real-world risk for this
platform per `docs/security.md`; weight findings in that category accordingly
over purely pattern-based findings.

## Anything to leave alone

- Anything under `node_modules`, `client/dist`, or other build output.
- The mdBook/Rust documentation toolchain (not part of this build).
- Alpine/npm dependency CVEs with no project-specific exploit path — those are
  already tracked by `npm audit`, Dependabot, and the project's container scan
  (Trivy) in CI; only report them here if you have a concrete path to exploit
  them through this project.
