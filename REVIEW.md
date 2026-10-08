# Review Checklist

What reviewers — people and AI review bots — check on every pull request, on
top of correctness. The automated checks listed in
[docs/security.md](docs/security.md#automated-security-checks) catch patterns;
this list covers what they cannot see, above all access control.

Report a finding as blocking only when you can trace a realistic path from a
caller or input to the failure. Name the OWASP category or WCAG criterion.

The checklist below is mirrored for GitHub Copilot code review in
`.github/instructions/review-checklist.instructions.md`; edit both together
(`tests/unit/server/review-checklist-sync.test.js` fails when they differ).

<!-- checklist:start -->

## Security (OWASP Top 10:2025)

**A01 Broken Access Control** (CWE-284, CWE-862, CWE-863, CWE-639, CWE-22, CWE-918)

- Every route under `server/routes/admin/` is guarded by `adminAuth` or
  `contentAdminAuth` (CI runs `npm run security:audit`). Other routes use
  `authRequired` or `authOptional`.
- A lookup by ID checks that the caller may see that resource, not only that
  it exists: apps, models, prompts, sources, chats and workflows go through
  the group permissions in `server/utils/authorization.js`
  (`filterResourcesByPermissions`).
- Delegated and machine principals (personal API keys, OAuth clients,
  agents) cannot reach admin or content-editing paths
  (`isAdminEligiblePrincipal`).
- Outbound requests to URLs from users, admins or model output go through the
  SSRF guard (`server/utils/ssrfGuard.js`, `server/utils/dnsGuard.js`).
- File paths built from request input cannot escape their directory (see
  `.claude/skills/api-security`).

**A02 Security Misconfiguration**

- New config defaults are safe without further setup. Debug options are off
  by default. CORS, cookies and security headers do not get looser without a
  stated reason.

**A03 Software Supply Chain Failures**

- A new dependency is needed, maintained and permissively licensed (CI:
  dependency review). GitHub Actions are pinned to a full commit SHA. Nothing
  is piped from `curl` into a shell.

**A04 Cryptographic Failures** (CWE-327, CWE-328, CWE-330)

- Secrets in `platform.json` are encrypted at rest through
  `TokenStorageService` and redacted on admin reads. No MD5 or SHA-1 for
  security purposes. AES-GCM checks a full 16-byte auth tag. Random values
  come from `crypto`, never `Math.random()`.

**A05 Injection** (CWE-78, CWE-79, CWE-89, CWE-90, CWE-94)

- Commands run through `execFile`/`spawn` with an argument array, never a
  shell string built from input. LDAP filters are escaped. No `eval` or
  `new Function` on input.
- HTML from users, documents or models is sanitized (DOMPurify, the existing
  markdown renderer) before `dangerouslySetInnerHTML`.
- Document text, tool results and web pages given to a model are data: they
  cannot change tool permissions or the system prompt (prompt injection).

**A06 Insecure Design**

- New authentication, token or expensive endpoints are rate limited. Abuse
  cases (enumeration, replay, unbounded uploads or loops) are considered.

**A07 Authentication Failures** (CWE-287, CWE-384)

- Sessions and tokens go through the existing auth middleware. Credentials
  and tokens never appear in URLs or logs.

**A08 Software or Data Integrity Failures**

- Changes to config files ship a versioned migration in `server/migrations/`;
  applied migrations are never edited. Config is validated against its Zod
  schema before use.

**A09 Security Logging and Alerting Failures**

- Security-relevant events (login, permission denial, admin changes) are
  logged through `server/utils/logger.js`, which redacts secrets. Nothing logs
  raw tokens, passwords or API keys.

**A10 Mishandling of Exceptional Conditions** (CWE-703, CWE-209)

- Errors fail closed: when a permission or config lookup throws, access is
  denied. Clients get a generic error (`sendFailedOperationError`), not stack
  traces or internal paths.

## Accessibility (WCAG 2.2 AA)

- Clickable things are `<button>` or `<a>`; a `div` with `onClick` needs a
  role, `tabIndex` and keyboard handling (2.1.1).
- Every input has a visible or programmatic label (1.3.1, 4.1.2). Images
  have meaningful `alt`, or `alt=""` when decorative (1.1.1).
- Meaningful text meets 4.5:1 contrast; `text-gray-400` on white does not
  (1.4.3). Focus is visible (2.4.7) and targets are at least 24×24 px (2.5.8).
- Dialogs move focus in, trap it and return it on close (2.4.3). Interactive
  controls are not nested inside each other.
- New user-facing strings go through i18n (`t()`), in English and German.

<!-- checklist:end -->
