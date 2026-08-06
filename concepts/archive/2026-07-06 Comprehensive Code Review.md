# iHub Apps — Comprehensive Code Review

**Date:** 2026-07-06  
**Scope:** Full application — server (Node/Express), client (React/Vite), configuration & defaults, and peripheral platforms (Electron, browser extension, Nextcloud, Teams).  
**Method:** 20 parallel area reviewers → per-category dedup → adversarial verification (independent skeptic agents, high-severity items double-verified) → manual spot-verification of the trailing security batch.

**Interactive triage board:** an interactive, filterable version of this list (filter by area / severity / confidence, search across files) is in [`review-triage.html`](./review-triage.html), also published at https://claude.ai/code/artifact/7899abe6-ed5e-4244-9020-3f98ea2908e0

## Summary

**168 findings** after de-duplicating 205 raw observations (10 refuted claims dropped).

| Severity | Count |
|---|---|
| high | 29 |
| medium | 84 |
| low | 55 |

| Category | Count |
|---|---|
| Security | 26 |
| Bugs & Correctness | 48 |
| Duplication | 27 |
| Dead Code | 11 |
| Architecture | 21 |
| Simplification | 10 |
| Configuration & Build | 16 |
| Performance | 3 |
| Testing | 4 |
| Documentation | 2 |

### Confidence

- **122 verified** — confirmed by an independent adversarial verifier agent, or manually re-confirmed against the code.
- **9 evidence-backed** — precise file:line evidence recorded, but the independent verification pass was cut short by a token limit. Treat as high-probability, worth a quick confirm before filing.
- **37 design suggestions** — architecture/simplification/testing/docs judgment calls (not the kind of claim that is adversarially "verified").

> Each finding below is written as a ready-to-file GitHub issue: title, labels, affected files, problem, evidence, and recommended fix.

## 🚩 Start here — verified high-severity items

- **[security]** Remove default admin password (admin/password123) from production defaults, or force a change — `server/defaults/config/users.json`
- **[security]** Sanitize user messages rendered via dangerouslySetInnerHTML in ChatMessage — `client/src/features/chat/components/ChatMessage.jsx`
- **[security]** Validate returnUrl before redirect — open redirect and javascript: URI XSS after login — `client/src/pages/LoginPage.jsx`
- **[security]** CodeNode workflow sandbox is escapable — host intrinsics leak the Function constructor — `server/services/workflow/executors/CodeNodeExecutor.js`
- **[security]** Enforce owner authorization on workflow execution endpoints (IDOR) — `server/routes/workflow/workflowRoutes.js`
- **[security]** Anonymous users bypass per-app permission checks on chat endpoints — `server/middleware/authRequired.js`
- **[security]** Auth and inference rate limiters are mounted on wrong paths and never fire — `server/middleware/setup.js`
- **[bug]** Fix cross-request tool-call state contamination: streaming converters share a single 'default' state for all chats — `server/adapters/toolCalling/OpenAIConverter.js`
- **[bug]** Default WORKERS=4 clustering runs one-time bootstrap and file-writing schedulers in every worker — racy migrations and clobbered JSON state — `server/config.js`
- **[bug]** Fix copy-pasted `error: err`/`error: e` in ~19 catch blocks — error paths throw ReferenceError, crashing auth, chats, streams, and the process — `server/middleware/proxyAuth.js`
- **[bug]** Protected-group list uses wrong IDs — the real 'admins' group can be deleted, locking out all admins — `server/routes/admin/groups.js`
- **[bug]** Office add-in manifest.xml endpoint always 500s (undefined variables) — `server/routes/integrations/officeAddin.js`
- **[bug]** Cancellation and node timeout cannot interrupt an in-flight LLM/tool loop — `server/services/workflow/executors/PromptNodeExecutor.js`
- **[duplication]** Deduplicate ToolExecutor's two ~250-line streaming loops; the continuation loop silently drops thinking, images, and grounding — `server/services/chat/ToolExecutor.js`
- **[config]** docker-compose.prod.yml is stale and incompatible with the current server (read-only config + host contents mounts) — `docker/docker-compose.prod.yml`

---

## Contents

- [🔒 Security](#security) (26)
- [🐛 Bugs & Correctness](#bugs-correctness) (48)
- [♻️ Duplication](#duplication) (27)
- [🗑️ Dead Code](#dead-code) (11)
- [🏛️ Architecture](#architecture) (21)
- [✂️ Simplification](#simplification) (10)
- [⚙️ Configuration & Build](#configuration-build) (16)
- [⚡ Performance](#performance) (3)
- [🧪 Testing](#testing) (4)
- [📄 Documentation](#documentation) (2)

---

## 🔒 Security

### 1. Remove default admin password (admin/password123) from production defaults, or force a change

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/defaults/config/users.json:9`
- `server/defaults/config/platform.json:113`
- `client/src/features/auth/components/LoginForm.jsx:459`
- `docker-compose.quickstart.yml:13`

**Problem:** Every fresh install (including the 'zero-config' production Docker quickstart pulling ghcr.io/intrafind/ihub-apps:latest) boots with a well-known admin account: users.json ships bcrypt hashes for admin/password123 and user/password123, platform.json defaults `localAuth.enabled: true` and `showDemoAccounts: true`, and the login page literally prints 'Admin: admin / password123'. Nothing (setup wizard, entrypoint, NODE_ENV check) forces a password change or disables the accounts, so any internet-reachable default deployment is trivially takeover-able. The Zod schema even says the default should be false (platformConfigSchema.js:144), contradicting the shipped default.

**Evidence:** server/defaults/config/users.json:9 `"passwordHash": "$2b$12$CNq/..."` with `"internalGroups": ["admins"]`; server/defaults/config/platform.json:116 `"showDemoAccounts": true`; LoginForm.jsx:459 `<p>Admin: admin / password123</p>`; docker-compose.quickstart.yml runs the production image with no credential setup. docs/security.md:72 recommends `"showDemoAccounts": false`.

**Recommended fix:** Default showDemoAccounts to false, generate a random admin password on first boot (print once to log) or force a password change via the setup wizard, and gate demo accounts behind NODE_ENV=development.

---

### 2. Sanitize user messages rendered via dangerouslySetInnerHTML in ChatMessage

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `client/src/features/chat/components/ChatMessage.jsx:618`
- `client/src/features/chat/components/ChatMessage.jsx:483`

**Problem:** A user message whose content merely contains the substring '<img' or 'data:image' is rendered as raw HTML with dangerouslySetInnerHTML and no DOMPurify pass. Every other render path in the app (StreamingMarkdown, MarkdownViewer, UnifiedPage, export HTML) sanitizes; this one does not. Message content is user/attacker-influenced: pasted text, prompts pre-filled via short links, and chat histories reloaded from storage or the conversations API all flow through here, so `<img src=x onerror=...>` executes in the app origin (cookies, localStorage authToken accessible).

**Evidence:** ChatMessage.jsx:479-488 `const hasImageContent = !!message.imageData || (... contentToRender.includes('<img') || contentToRender.includes('data:image'));` and :614-620 `if (hasHTMLContent && isUser) { return (<div ... dangerouslySetInnerHTML={{ __html: contentToRender }} />); }` — no DOMPurify. Compare StreamingMarkdown.jsx:60 `setHtmlContent(DOMPurify.sanitize(parsedContent))`.

**Recommended fix:** Wrap contentToRender in DOMPurify.sanitize() before dangerouslySetInnerHTML (allow img/data: URIs explicitly if needed), or render attachments from structured message.imageData/fileData fields instead of sniffing HTML in the content string.

---

### 3. Validate returnUrl before redirect — open redirect and javascript: URI XSS after login

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `client/src/pages/LoginPage.jsx:16`
- `client/src/pages/LoginPage.jsx:37`
- `client/src/shared/contexts/AuthContext.jsx:249`

**Problem:** LoginPage stores the raw returnUrl query parameter in sessionStorage without validation and later navigates to it via window.location.href. AuthContext.loginWithToken does the same for the stored value. The auth-gate deliberately validates returnUrl as same-origin (auth-gate.js getEffectiveReturnUrl, comment: 'Same-origin only to avoid open-redirect'), but the React login path skips that check entirely. An attacker can send a link like /login?returnUrl=https://evil.example/phish (open redirect after successful login) or returnUrl=javascript:... (script execution in page context).

**Evidence:** LoginPage.jsx:16-17 `if (returnUrl && !sessionStorage.getItem('authReturnUrl')) { sessionStorage.setItem('authReturnUrl', returnUrl); }` then :34-39 `window.location.href = storedReturnUrl; } else if (returnUrl) { window.location.href = returnUrl;`. AuthContext.jsx:240-249 `const returnUrl = sessionStorage.getItem('authReturnUrl'); ... window.location.href = returnUrl;`. Contrast auth-gate.js:890-908 which requires `resolved.origin === window.location.origin`.

**Recommended fix:** Reuse the auth-gate's same-origin validation: resolve with new URL(returnUrl, window.location.origin), reject anything whose origin differs or protocol is not http(s), and prefer navigate(pathname). Apply at both write (LoginPage/SetupWizard) and read (AuthContext) sites.

---

### 4. CodeNode workflow sandbox is escapable — host intrinsics leak the Function constructor

**Severity:** high · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `security` `sev:high`

**Files:**
- `server/services/workflow/executors/CodeNodeExecutor.js:143`
- `server/services/workflow/executors/CodeNodeExecutor.js:146`
- `server/services/marketplace/ContentInstaller.js:92`

**Problem:** CodeNodeExecutor documents a 'secure VM sandbox' and blocks the global Function, but injects the host realm's built-ins (Array, String, Number, RegExp, Map, Set, Promise, Date). Because these are host-realm objects, `Array.constructor` IS the host Function, so `Array.constructor('return process')()` escapes the sandbox and gives arbitrary code execution. node:vm is explicitly not a security boundary; LoopNodeExecutor avoids this by exposing no host objects. Marketplace-installed workflows are NOT schema-validated (ContentInstaller validate is a no-op), and executions run under authRequired for any authenticated user — a compromised registry can ship a code node that RCEs on execution.

**Evidence:** CodeNodeExecutor.js:146-178 `Object.assign(sandbox, { data, ..., Array, String, Number, RegExp, ... Map, Set, Promise })` injects host intrinsics; line 143 only nulls `sandbox.Function`. Comment (lines 1-13) claims these measures make it secure. ContentInstaller.js:88-93 `workflow: { ... validate: async () => ({ success: true }) }`. workflowRoutes.js:1144 execution endpoint uses only `authRequired`.

**Recommended fix:** Do not treat node:vm as a security boundary. Run untrusted code in a real isolate (isolated-vm / worker with limits) or expose only sandbox-realm intrinsics (define built-ins inside the vm context), add schema validation for marketplace workflows, and correct the 'secure sandbox' comments.

---

### 5. Enforce owner authorization on workflow execution endpoints (IDOR)

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `security` `sev:high`

**Files:**
- `server/routes/workflow/workflowRoutes.js:946`
- `server/routes/workflow/workflowRoutes.js:1056`
- `server/routes/workflow/workflowRoutes.js:1226`
- `server/routes/workflow/workflowRoutes.js:1474`
- `server/routes/workflow/workflowRoutes.js:1584`
- `server/routes/workflow/workflowRoutes.js:1813`

**Problem:** The per-execution endpoints GET state, /stream, /export, /resume, /restart, /cancel and /respond are gated only by `authRequired` plus a `filterByPermissions([workflow], req.user)` check on the workflow *definition*. None verify the caller owns the *execution instance*. Any user permitted to run a workflow (or any anonymous user when anonymousAuth is enabled) who learns an executionId can read another user's full run state/inputs/outputs or control it (/cancel, /resume, /restart, /respond). Only DELETE and PATCH check `execution.userId !== currentUserId`; the agent runs router added `authorizeRunAccess`, showing the omission is an oversight.

**Evidence:** Line 1318/1416 guard with `if (execution.userId !== currentUserId && !isAdmin(req.user))`. GET state (946), export (1474), stream (1584), resume (1056), restart (1141), cancel (1226), respond (1813) have no such check — they call `workflowEngine.getState(executionId)` / `.cancel()` directly after only `filterByPermissions([workflow]...)`. Contrast server/routes/agents/runs.js:121 `authorizeRunAccess()`.

**Recommended fix:** Add an ownership guard (owner userId from the ExecutionRegistry, or admin) to every per-execution endpoint, mirroring the DELETE/PATCH checks and the agent runs `authorizeRunAccess` helper. Extract one shared helper and apply it uniformly.

---

### 6. Anonymous users bypass per-app permission checks on chat endpoints

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `security` `sev:high`

**Files:**
- `server/middleware/authRequired.js:173`
- `server/routes/chat/sessionRoutes.js:631`
- `server/services/chat/RequestBuilder.js:147`

**Problem:** When anonymousAuth.enabled is true, chatAuthRequired only runs appAccessRequired for users where `req.user && req.user.id !== 'anonymous'`. For a tokenless anonymous request req.user is undefined and no middleware materializes an anonymous principal, so appAccessRequired is skipped entirely. prepareChatRequest then looks up the app by id with no permissions check. An anonymous user who knows an app id can open the SSE stream and POST chat messages to ANY app — including non-allowlisted apps with sensitive system prompts/tools. The /api/apps list hides these apps but the chat endpoint doesn't. Authenticated users ARE gated, so the gap is anonymous-specific.

**Evidence:** authRequired.js:173 `if (req.user && req.user.id !== 'anonymous') { return appAccessRequired(...) }` else `next()`. resourceAccessRequired (authRequired.js:97) also no-ops when `!req.user`. setup.js:631 `if (req.user && !req.user.permissions)` — never fires for anonymous. RequestBuilder.js:147 `const app = apps.find(a => a.id === appId)` with no permission gate. Contrast generalRoutes.js:174 which builds an anonymous principal for the list endpoint.

**Recommended fix:** Materialize the anonymous principal (with resolved permissions) once in a shared middleware after the auth chain, and have chatAuthRequired/appAccessRequired enforce app permissions for anonymous principals too. Add a test posting an anonymous chat to a non-allowlisted app expecting 403.

---

### 7. Auth and inference rate limiters are mounted on wrong paths and never fire

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/middleware/setup.js:570`
- `server/middleware/setup.js:573`
- `server/routes/auth.js:91`
- `server/routes/openaiProxy.js:22`

**Problem:** The brute-force limiter for authentication is mounted at '/auth' and the inference limiter at '/inference', but every auth endpoint is registered under '/api/auth/...' and the OpenAI-compatible proxy under '/api/inference'. Express path mounting means neither limiter ever matches a real request, so POST /api/auth/local/login (and LDAP/NTLM login) has NO rate limiting at all — the 50-requests-per-15-min brute-force protection the code clearly intends is dead. Same for the inference API limiter.

**Evidence:** setup.js:570 `app.use(buildServerPath('/auth'), rateLimiters.authApiLimiter);` and :573 `app.use(buildServerPath('/inference'), rateLimiters.inferenceApiLimiter);` — buildServerPath returns the path unchanged (basePath.js:68-74). Actual routes: auth.js:91 `app.post(buildServerPath('/api/auth/local/login')...)`, openaiProxy.js:22 `const base = buildServerPath('/api/inference');`. rateLimiting.js:80-86 shows authApiConfig limit 50/15min 'More restrictive for auth endpoints' — never applied. Grep confirms these limiters are mounted nowhere else.

**Recommended fix:** Mount at buildApiPath('/auth') and buildApiPath('/inference') (i.e. '/api/auth', '/api/inference'). Add a startup smoke test that hits /api/auth/local/login 51 times and expects a 429.

---

### 8. Base-path rewrite runs after auth chain and rate limiters, enabling auth-skip and X-Forwarded-Prefix limiter bypass

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/server.js:428`
- `server/server.js:434`
- `server/utils/basePath.js:206`
- `server/middleware/setup.js:56`

**Problem:** basePath.js documents basePathRewriteMiddleware 'Must be registered BEFORE all other middleware', but server.js registers it AFTER setupMiddleware. All rate limiters, the auth-skip heuristic, sessions and audit logging therefore see the un-rewritten URL. Under a non-stripping reverse proxy ('/ihub/api/...'), isStaticAssetRequest misclassifies every API call as an SPA route and SKIPS the whole auth chain. Worse, X-Forwarded-Prefix is trusted from any client: an attacker requests '/x/api/auth/local/login' with header 'X-Forwarded-Prefix: /x' — pre-rewrite middleware won't match, then the rewrite strips '/x' and routes normally, bypassing every path-mounted limiter.

**Evidence:** server.js:428 `setupMiddleware(app, platformConfig);` then :434-436 `app.use(basePathRewriteMiddleware); ...`. basePath.js:206 'Must be registered BEFORE all other middleware and routes.' basePath.js:220-222 rewrites req.url from the client-controllable header with no trust-proxy validation. setup.js:56 `if (path.startsWith('/api')) return false;` and :83-84 SPA route check → '/x/api/...' is treated as SPA and auth is skipped (setup.js:98-100).

**Recommended fix:** Register basePathRewriteMiddleware as the very first app.use, before setupMiddleware. Additionally only honor X-Forwarded-Prefix when the request comes from a trusted proxy (align with express 'trust proxy').

---

### 9. Scope admin sources file API to contents/sources — contentAdmin can read/write all of contents/ (privilege escalation)

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/routes/admin/sources.js:1859`
- `server/routes/admin/sources.js:1742`
- `server/routes/admin/sources.js:1972`
- `server/sources/FileSystemHandler.js:21`
- `server/validators/sourceConfigSchema.js:215`

**Problem:** The filesystem-source file endpoints (GET/POST/DELETE /api/admin/sources/:id/files*) are guarded by contentAdminAuth (weaker than adminAccess) and pass the raw request `path` to FileSystemHandler, whose basePath is the ENTIRE contents/ directory, not contents/sources. A contentAdmin can read `contents/.encryption-key` and `config/users.json` (bcrypt hashes), and write `config/groups.json` or `config/platform.json` — e.g. grant their own group `adminAccess: true` — escalating to full admin and decrypting every stored secret. The same root cause lets a filesystem source's `config.path` point at any file under contents/ (schema only blocks `..`, `~`, absolute paths).

**Evidence:** sources.js:1891 `const result = await handler.writeFile(path, content, encoding);` with `path` from req.body, route guarded only by `contentAdminAuth` (sources.js:1862). FileSystemHandler.js:21 `this.basePath = handlerConfig.basePath || path.join(rootDir, contentsDir);` (whole contents/). sourceConfigSchema.js:217 only rejects `path.includes('..') || path.includes('~')`, so `config/groups.json` and `.encryption-key` are valid paths.

**Recommended fix:** Give the admin file routes (and filesystem sources) a handler whose basePath is `contents/sources`, or validate the requested/stored path with resolveAndValidatePath against contents/sources. Additionally deny-list dotfiles (.encryption-key, .jwt-*) and config/.

---

### 10. Stop putting the Google API key in the request URL — it gets logged on every provider HTTP error

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/adapters/google.js:393`
- `server/adapters/google.js:397`
- `server/services/chat/StreamingHandler.js:367`

**Problem:** The Google adapter appends the API key as a query parameter (`?alt=sse&key=${apiKey}`). StreamingHandler logs the full request URL at error level whenever the provider returns a non-OK status, so any Gemini quota/4xx/5xx error writes the plaintext API key into server logs (and into any log aggregation). Gemini supports the `x-goog-api-key` header, which every other adapter's header-based auth pattern already matches; there is no `x-goog-api-key` usage anywhere in the codebase.

**Evidence:** google.js:393 `url = `${baseUrl}?alt=sse&key=${apiKey}``; google.js:397 `url = `${nonStreamingUrl}?key=${apiKey}``. StreamingHandler.js:362-370 `logger.error('HTTP error from LLM provider', { ... url: request.url, ... })`. `grep -rn "x-goog-api-key" server/` returns nothing.

**Recommended fix:** Send the key via the `x-goog-api-key` header and keep only `alt=sse` in the query string. As defense in depth, redact `key=` query parameters in StreamingHandler's error logging.

---

### 11. Screenshot tools navigate to arbitrary URLs with no SSRF guard

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/tools/playwrightScreenshot.js:19`
- `server/tools/seleniumScreenshot.js:20`
- `server/tools/webContentExtractor.js:12`

**Problem:** playwrightScreenshot and seleniumScreenshot launch a real headless browser and call page.goto(url)/driver.get(url) on the caller-supplied URL with zero validation — no protocol check, no private-IP block. The sibling webContentExtractor.js explicitly blocks loopback/private/link-local ranges (127.*, 10.*, 172.16-31.*, 192.168.*, 169.254.* at lines 14-18, throwing SSRF_BLOCKED). A browser hitting 169.254.169.254 or internal hosts, then returning a screenshot/extracted PDF text, is a classic SSRF that can exfiltrate cloud metadata credentials or internal pages.

**Evidence:** playwrightScreenshot.js:25-38 `if (!url) throw...; ... await page.goto(url, {waitUntil:'networkidle'})` — no URL guard. seleniumScreenshot.js:26-41 `await driver.get(url)` — no guard. Compare webContentExtractor.js:38 `throw createError('Access to private/internal IP addresses is not allowed', 'SSRF_BLOCKED')`. Both tools default enabled.

**Recommended fix:** Extract webContentExtractor's URL/DNS validation into a shared util (e.g. utils/urlSafety.js) and call it in both screenshot tools before goto/get. Reject non-http(s) schemes and resolved private/link-local IPs.

---

### 12. SSRF guard in webContentExtractor is bypassable via HTTP redirects and DNS rebinding

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** medium  
**Labels:** `security` `sev:high`

**Files:**
- `server/tools/webContentExtractor.js:99`
- `server/tools/webContentExtractor.js:130`
- `server/utils/httpConfig.js:469`

**Problem:** webContentExtractor validates only the initial hostname's resolved IP (assertNotPrivateIp), then fetches via throttledFetch->httpFetch->node-fetch, which follows redirects by default with no per-hop re-check and no pinned DNS lookup. An attacker-controlled public host can 302-redirect to http://169.254.169.254/ (cloud metadata) or any RFC1918 address, and the fetch follows it. There's also a TOCTOU/DNS-rebinding gap: dns.lookup resolves once for the check, then node-fetch re-resolves at connect time. The tool is user-reachable — an LLM agent tool invoked by braveSearch's extractContent on result URLs — so a user prompt can drive it to a chosen URL.

**Evidence:** Line 100: `await assertNotPrivateIp(validUrl.hostname);` checks only the first hop. Line 130: `throttledFetch('webContentExtractor', targetUrl, enhancedOptions)` with no `redirect:'manual'` and no `lookup`. httpConfig.js:469 `return nodeFetch(url, enhanced);` (default redirect='follow'). Correct primitive exists in server/services/workflow/executors/ssrfGuard.js (assertPublicTarget + createPinnedLookup) but is unused here. braveSearch.js exposes extractContent over result URLs.

**Recommended fix:** Route webContentExtractor (and braveSearch page extraction) through a DNS-pinned fetch that re-validates every redirect hop — reuse ssrfGuard.assertPublicTarget + createPinnedLookup, or set redirect:'manual' and re-assert each Location before following.

---

### 13. Teams login path never checks disabled-account status

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `server/middleware/teamsAuth.js:123`
- `server/middleware/teamsAuth.js:202`
- `server/middleware/teamsAuth.js:86`

**Problem:** Every other external provider (OIDC, LDAP, NTLM, proxy) routes through validateAndPersistExternalUser(), which throws if the persisted user has active===false. teamsAuthMiddleware and teamsTokenExchange build the user via normalizeTeamsUser() and immediately mint an 8h JWT — they never persist the user and never consult users.json for active status. jwtAuth's teams branch only rejects when a userRecord is found AND inactive, but since Teams users are never persisted the record is usually absent, so the check is skipped. Net effect: an administrator cannot disable a Teams user.

**Evidence:** teamsAuth.js:173 `const user = normalizeTeamsUser(...)` then :176 `generateJwt(user,{authMode:'teams'...})` with no active check; grep of validateAndPersistExternalUser callers shows oidc/ldap/ntlm/proxy but NOT teamsAuth. jwtAuth.js:535 `if (userRecord && !isUserActive(userRecord))` fails open when userRecord is undefined.

**Recommended fix:** Route Teams users through validateAndPersistExternalUser() like the other external providers so the active-status gate and persistence apply uniformly.

---

### 14. Stop loading @babel/standalone from public CDNs at runtime; the bundled dependency is unused

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `client/src/shared/components/ReactComponentRenderer.jsx:100`
- `client/src/pages/UnifiedPage.jsx:31`
- `client/package.json:12`
- `client/vite.config.js:73`

**Problem:** ReactComponentRenderer and UnifiedPage both inject <script src='https://unpkg.com/@babel/standalone/babel.min.js'> (unpinned, no SRI) then execute the compiled output with new Function. A compromised or MITM'd CDN response means arbitrary code execution in the app origin. It also breaks React pages entirely in air-gapped/self-hosted enterprise deployments — the product's primary model. Meanwhile @babel/standalone ^7.28.1 is declared in package.json and vite.config.js reserves a 'babel' chunk, but no source file imports it, so the dependency and chunk config are dead while the CDN path is live.

**Evidence:** ReactComponentRenderer.jsx:99-102 `const babelUrls = ['https://unpkg.com/@babel/standalone/babel.min.js', 'https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js'];` UnifiedPage.jsx:31 `script.src = 'https://unpkg.com/@babel/standalone/babel.min.js';` package.json:12 `"@babel/standalone": "^7.28.1"`. vite.config.js:73 `babel: ['@babel/standalone']`. `grep -rn "from '@babel"` in client src returns nothing.

**Recommended fix:** Replace the CDN loader with a lazy `await import('@babel/standalone')` (the vite 'babel' chunk already anticipates this), delete the duplicated script-injection code in UnifiedPage (ReactComponentRenderer already handles loading), and drop the CDN URLs.

---

### 15. Sanitize workflow output markdown before dangerouslySetInnerHTML (XSS)

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** small  
**Labels:** `security` `sev:high`

**Files:**
- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx:55`
- `client/src/utils/markdownUtils.js:10`
- `client/src/features/workflows/components/HumanCheckpoint.jsx:72`

**Problem:** WorkflowExecutionPage's renderValue() converts workflow output strings to HTML with markdownToHtml() and injects them via dangerouslySetInnerHTML with no sanitization. markdownToHtml uses marked with `sanitize: false` so raw HTML passes through. Workflow outputs are LLM-generated and routinely incorporate attacker-influenceable content (uploaded documents, web/tool results), so an injected `<img onerror=...>` in a workflow result executes in the viewer's session. The sibling HumanCheckpoint.jsx:72 correctly wraps the same call in DOMPurify.sanitize(), and chat's StreamingMarkdown sanitizes too — this page is the unintentional gap; the 'trusted (same as chat)' comment is false.

**Evidence:** WorkflowExecutionPage.jsx:55-60: `const html = markdownToHtml(value); return (<div ... dangerouslySetInnerHTML={{ __html: html }} />)`. markdownUtils.js:7-11: `marked.setOptions({ ... sanitize: false })`. Contrast HumanCheckpoint.jsx:72: `const safeHtml = DOMPurify.sanitize(markdownToHtml(value));` and MarkdownViewer.jsx:25. renderValue is used for primary output (1132) and every accordion field (587, 604, 614).

**Recommended fix:** Wrap the conversion in DOMPurify.sanitize() exactly as HumanCheckpoint.jsx does. Better: make markdownToHtml sanitize by default and add an explicit unsafe variant for the one ReactQuill case.

---

### 16. docker-ci.yml lets any GitHub commenter trigger a build that pushes the public :latest image

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:medium`

**Files:**
- `.github/workflows/docker-ci.yml:12`
- `.github/workflows/docker-ci.yml:61`
- `.github/workflows/docker-ci.yml:135`
- `.github/workflows/docker-ci.yml:148`

**Problem:** The Docker CI workflow triggers on `issue_comment: created` and only checks that the comment body contains '@build docker images' — there is no author_association or permission check. On issue_comment the workflow runs on the default branch, so any user who can comment on any issue can force a build of current (unreleased) main and push it to GHCR with `packages: write`; because the ref is the default branch, the metadata-action's `type=raw,value=latest,enable={{is_default_branch}}` rule also overwrites the `latest` tag consumers pull. summary.yml has an equivalent guard commented out (citing GHSA-f79p-xmmr-m7xg).

**Evidence:** docker-ci.yml:12-13 `issue_comment: types: [created]`; :61 `if grep -q "@build docker images" comment_body.txt` (no author check); :83 `packages: write`; :135 `type=raw,value=latest,enable={{is_default_branch}}`; :148 `push: true`. summary.yml:9-15 shows the equivalent guard commented out.

**Recommended fix:** Gate the comment trigger on `github.event.comment.author_association` in (OWNER, MEMBER, COLLABORATOR), or drop the issue_comment trigger and rely on workflow_dispatch. Also restrict `latest` tagging to release events.

<sub>Verifier: Verified in docker-ci.yml: trigger `issue_comment: [created]` (:12-13); check-trigger job (:40-74) gates only on `grep -q "@build docker images"` (:61) with zero author/permission check; build job runs with `packages: write` (:83), `type=raw,value=latest,enable={{is_default_branch}}` (:135, true sin</sub>

---

### 17. Escape appName, watermark text, and settings (incl. user variables) in exported/printed HTML

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:medium`

**Files:**
- `client/src/api/endpoints/apps.js:324`
- `client/src/api/endpoints/apps.js:334`
- `client/src/api/endpoints/apps.js:290`

**Problem:** generatePDFHTML carefully escapes docTitle via escapeHtml (added specifically because the title is attacker-controlled per the code comment) and sanitizes message bodies with DOMPurify, but interpolates appName, watermark.text, settings.model/style/outputFormat and every settings.variables key/value into the document raw. settings.variables are user-supplied form inputs (pre-fillable via shared short links). The document is rendered same-origin through an iframe srcdoc for printing (printHtmlDocument), so injected markup executes with the app's origin; the same unescaped HTML is also written to disk by exportChatToHTML.

**Evidence:** apps.js:24-27 comment: title 'is attacker-controlled and must not be rendered as raw HTML' with :314/:323 `${escapeHtml(docTitle)}` — but :324 `${appName ? `<h2>${appName}</h2>` : ''}`, :334 `${watermark.text ? `<div class="watermark">${watermark.text}</div>` : ''}`, :290-299 `<div>...${settings.model}</div> ... ${Object.entries(settings.variables).map(([k, v]) => `${k}: ${v}`).join(', ')}` all unescaped. :174 `iframe.srcdoc = htmlContent`.

**Recommended fix:** Apply the existing escapeHtml() to appName, watermark.text, and all settings values/keys in generatePDFHTML, mirroring the docTitle treatment. Consider adding sandbox="allow-modals" to the print iframe as defense in depth.

<sub>Verifier: Verified in apps.js: docTitle escaped (:314/:323) but appName (:324), watermark.text (:334), settings.model/style/outputFormat (:290/:292/:293) and variables key+value (:297-299) interpolated raw. printHtmlDocument sets iframe.srcdoc (:174) on a non-sandboxed iframe (:138-144) → same-origin executio</sub>

---

### 18. User group/permission changes are frozen in the JWT until expiry (asymmetric revocation)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `security` `sev:medium`

**Files:**
- `server/middleware/jwtAuth.js:379`
- `server/utils/tokenService.js:116`
- `server/middleware/jwtAuth.js:444`

**Problem:** On each request jwtAuth re-validates account active-status from users.json and re-reads OAuth client permissions fresh, but for user identity it takes `groups: decoded.groups` verbatim from the signed token and never re-resolves internalGroups from users.json. Because isAdmin is derived from these groups in enhanceUserWithPermissions, demoting a local user out of an admin group (or changing any group membership) has no effect until the token expires — default 8h, and static API keys live 365 days. The code deliberately re-checks other fields per request but not group membership.

**Evidence:** jwtAuth.js:379-387 local user built with `groups: decoded.groups || []`; no read of userRecord.internalGroups. Contrast OAuth client_credentials which re-reads client.allowedApps/Models each request (jwtAuth.js:288-292). authorization.js:621 derives isAdmin from user.groups.

**Recommended fix:** For persisted modes, re-hydrate groups from the current users.json record (internalGroups + provider/authenticated groups) on each request, or shorten token lifetimes and document the revocation window.

<sub>Verifier: Verified: jwtAuth.js:384 builds local user with groups:decoded.groups verbatim; userRecord (users.json) is read only for isUserActive (367), never re-resolving internalGroups. Same for oidc(449)/ldap(504)/teams(551)/ntlm(600). tokenService.js:116 bakes groups at mint. authorization.js:621 derives is</sub>

---

### 19. JWT validation fails open for OIDC/LDAP/Teams/NTLM when the user record is missing

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:medium`

**Files:**
- `server/middleware/jwtAuth.js:356`
- `server/middleware/jwtAuth.js:432`
- `server/middleware/jwtAuth.js:488`
- `server/middleware/jwtAuth.js:535`
- `server/middleware/jwtAuth.js:584`

**Problem:** For authMode 'local', jwtAuth rejects with 401 when the user no longer exists in users.json (`if (!userRecord) return 401`). For oidc/ldap/teams/ntlm the code only rejects when a record is found and inactive (`if (userRecord && !isUserActive(userRecord))`); a missing record falls through and the request is authenticated purely from the (still-valid, signed) token. Because these providers persist users at login, a *deleted* external user keeps full access until the token expires (default 8h, configurable higher). The security posture is inconsistent: deleting a local user revokes immediately, deleting an external user does not.

**Evidence:** Local: jwtAuth.js:356 `if (!userRecord){...return res.status(401)...}`. OIDC: jwtAuth.js:432 `if (userRecord && !isUserActive(userRecord))` — no else-branch rejecting a null record; same shape at :488 (LDAP), :535 (Teams), :584 (NTLM).

**Recommended fix:** Decide a single policy. If external identities must exist locally to be valid, reject when userRecord is null for all persisted modes; otherwise document the intentional fail-open. At minimum make local and external modes symmetric.

<sub>Verifier: Code matches exactly: local branch rejects null userRecord (jwtAuth.js:356, 401); oidc/ldap/teams/ntlm use `if (userRecord && !isUserActive(userRecord))` (:432/:488/:535/:584) with no null-rejection, building `user` from the signed token incl. decoded.groups. External users are persisted at login (u</sub>

---

### 20. Info-level logging of user prompts, conversation bodies, and model config leaks sensitive content

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:medium`

**Files:**
- `server/adapters/openai-responses.js:232`
- `server/adapters/google.js:600`
- `server/adapters/openai.js:156`
- `server/utils.js:515`
- `server/routes/magicPromptRoutes.js:75`
- `server/routes/admin/translate.js:52`

**Problem:** Multiple code paths log full user/conversation content at info level, contradicting the codebase's own policy (telemetry strips OTLP headers; other adapters disabled body logging 'to prevent exposing sensitive data'; GenAI prompt/completion capture is opt-in). openai-responses.js logs the entire request body (system instructions + all messages) on every GPT-5 request; google.js logs the full parsed Gemini response (incl. base64 images); openai.js logs per-schema-node info. utils.simpleCompletion logs the complete messages payload plus full modelConfig (may embed per-model API keys) on every call — reached by magicPrompt, admin translate, prompt/agent/model generation.

**Evidence:** openai-responses.js:232 `logger.info('OpenAI Responses API request body', { body: JSON.stringify(body, null, 2) })` (body has instructions+input). google.js:600 `logger.info('Full Gemini response structure', { parsed: JSON.stringify(parsed, null, 2) })`. openai.js:156 per-node schema log. utils.js:515 `logger.info('Starting simple completion...', { messages: JSON.stringify(messages, null, 2) })`, :526 full modelConfig; callers magicPromptRoutes.js:75, admin/translate.js:52. Contrast openai.js:189 comment and telemetry.js 'headers intentionally omitted'.

**Recommended fix:** Demote all these to logger.debug and log only metadata (model id, message count, total chars). Never log message content or full modelConfig at info; strip/remove the adapter body/response logs and the per-node schema log.

<sub>Verifier: Core claim verified: openai-responses.js:232 (full body=instructions+messages), google.js:600 (full response), utils.js:515 (full messages, via magicPromptRoutes.js:75 / admin/translate.js:52) log user content verbatim at info. The auto-redactor (logger.js:376,429) only matches exact sensitive keys </sub>

---

### 21. Chat flow does not enforce user model-level permissions

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `security` `sev:medium`

**Files:**
- `server/services/chat/RequestBuilder.js:82`
- `server/services/chat/RequestBuilder.js:205`

**Problem:** prepareChatRequest resolves the model via filterModelsForApp, which filters only by app requirements (allowedModels, tool support, settings.model.filter) — never by the requesting user's permissions.models. The chat POST route also has no modelAccessRequired middleware. So a user (or anonymous principal) can pass any modelId the app permits and use it, ignoring their group's models allowlist. This is inconsistent with /api/models and /api/models/:modelId, which both filter/deny by user.permissions.models. A restricted group with apps:['*'] but models:['cheap-model'] can invoke expensive models via any app that allows them.

**Evidence:** RequestBuilder.js:82-107 filterModelsForApp takes only (models, app). RequestBuilder.js:205 `let resolvedModelId = modelId || app.preferredModel || defaultModel;` then validates only against the app-filtered list (line 229). The `user` param is used for prompts/tools/completion but never for model permission filtering.

**Recommended fix:** Intersect the app-filtered model list with user.permissions.models (honoring '*') before resolving/validating the requested model, and return 403 when the requested model is outside the user's allowance. If app-scoped model access is intended, document it and align the list endpoints.

<sub>Verifier: Verified against code. filterModelsForApp (RequestBuilder.js:79-107) filters only by app (allowedModels/tools/settings); models come from configCache.getModels() unfiltered (line 154). resolvedModelId (line 205) is validated only against the app-filtered list; `user` is never used for model-permissi</sub>

---

### 22. GET /api/admin/auth/users returns bcrypt password hashes despite documenting their exclusion

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:medium`

**Files:**
- `server/routes/admin/auth.js:269`
- `server/routes/admin/auth.js:443`

**Problem:** The user-list endpoint reads users.json and returns it verbatim: `res.json(usersData)` — including each user's `passwordHash` (bcrypt) — while its own swagger block three lines above says it 'excludes password hashes for security reasons'. The POST (auth.js:443) and PUT (auth.js:583) handlers carefully strip passwordHash from their responses, so this is an oversight, not a decision. Hashes end up in the admin browser, devtools, HTTP logs, and any proxy caches, enabling offline cracking of user passwords (min length is only 6 chars).

**Evidence:** auth.js:262-269: reads usersData from users.json then `res.json(usersData);` with no sanitization; swagger at auth.js:236-237: 'excludes password hashes for security reasons'. Default users.json record contains `passwordHash: '$2b$12$...'`. Contrast auth.js:443 `const { passwordHash: _passwordHash, ...userResponse } = newUser;`.

**Recommended fix:** Map users through the same destructuring strip used in POST/PUT before responding (and consider replacing it with a boolean `hasPassword`).

<sub>Verifier: Verified: auth.js:269 returns `res.json(usersData)` with no sanitization; swagger at 236-237 claims it "excludes password hashes." POST (443) and PUT (583) both strip passwordHash, as does localAuth.js:210 — proving the GET is an oversight. server/defaults/config/users.json ships real bcrypt cost-12</sub>

---

### 23. CSV/XLSX chat exports allow spreadsheet formula injection

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:low`

**Files:**
- `client/src/utils/exportFormats.js:721`
- `client/src/utils/exportFormats.js:671`

**Problem:** exportToCSV's escapeCSV only handles quoting (commas/quotes/newlines) and exportToXLSX writes message content directly as cell values. LLM- or user-authored message content beginning with '=', '+', '-' or '@' (e.g. '=HYPERLINK("http://evil","click")' or '=cmd|...') is interpreted as a formula when the exported file is opened in Excel/LibreOffice — a classic CSV-injection vector for chat transcripts whose content the user does not fully control (model output, pasted text).

**Evidence:** exportFormats.js:721-729 `const escapeCSV = value => { ... if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) { return `"${stringValue.replace(/"/g, '""')}"`; } return stringValue; };` — no formula-prefix guard. :671 `data.push([{ value: role }, { value: timestamp }, { value: content }]);` raw content into XLSX cells.

**Recommended fix:** Prefix cell values starting with =, +, -, @, \t or \r with a single quote (') or space in both exportToCSV and exportToXLSX, per OWASP CSV-injection guidance.

<sub>Verifier: Code matches claim. exportFormats.js:721-729 escapeCSV only quotes on comma/quote/newline — no leading =,+,-,@ guard, so `=HYPERLINK(...)` passes through raw. :671 pushes `{ value: content }` into XLSX cells unsanitized. Grep confirms no other sanitization in the module; content is arbitrary transcr</sub>

---

### 24. Local login is vulnerable to username enumeration via response timing

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:low`

**Files:**
- `server/middleware/localAuth.js:99`
- `server/middleware/localAuth.js:104`

**Problem:** loginUser() throws 'Invalid credentials' immediately when the username is not found, skipping the bcrypt.compare that runs (~100ms) for an existing user. Both cases return the same 401 message, but the response-time difference lets an attacker enumerate valid usernames/emails. The auth rate limiter (50 req / 15 min) narrows but does not close this. bcrypt.compare itself is constant-time, so only the short-circuit on missing user leaks.

**Evidence:** localAuth.js:99-101 `if (!user){ throw new Error('Invalid credentials'); }` returns before any hash work; localAuth.js:104 `verifyPasswordWithUserId(...)` (the expensive bcrypt path) only runs when the user exists.

**Recommended fix:** When the user is not found, run a bcrypt.compare against a fixed dummy hash before returning the generic error so both paths take comparable time.

<sub>Verifier: Verified in localAuth.js: line 99-101 throws immediately on missing user with no crypto work; line 104→66 runs bcrypt.compare (cost 12, ~hundreds ms) only for existing users. Route auth.js:158-162 returns identical 401 for both, so only timing leaks. No decoy-hash equalization exists (grep found bcr</sub>

---

### 25. TokenStorageService encrypts OAuth refresh tokens with unauthenticated AES-256-CBC; env key never validated

**Severity:** low · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `security` `sev:low`

**Files:**
- `server/services/TokenStorageService.js:300`
- `server/services/TokenStorageService.js:42`

**Problem:** The most sensitive data the service stores — user OAuth access/refresh tokens for Office365/GoogleDrive/Nextcloud — is encrypted with unauthenticated AES-256-CBC (no MAC) in encryptTokens/decryptTokens, while mere API-key strings get authenticated AES-256-GCM. The GCM docblock itself explains CBC is inferior, and the constructor's `this.algorithm = 'aes-256-gcm'` (line 19) is never used — dead/misleading. Separately, an env-provided TOKEN_ENCRYPTION_KEY is accepted without the 64-hex-char validation applied to persisted keys; a passphrase-style value silently yields a truncated/empty key via Buffer.from(key,'hex') and every encrypt/decrypt then throws 'Invalid key length' at runtime.

**Evidence:** TokenStorageService.js:300 `const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);` and :342 (decrypt) — no auth tag. :563-566 docblock: 'Uses GCM mode instead of CBC ... No padding oracle vulnerabilities'. :19 `this.algorithm = 'aes-256-gcm';` unused. :42-43 accepts env key with no format check; :295 `Buffer.from(this.encryptionKey, 'hex')`.

**Recommended fix:** Migrate encryptTokens/decryptTokens to the existing GCM ENC[...] envelope (keep CBC read-path one release to lazily re-encrypt). Validate TOKEN_ENCRYPTION_KEY is 64 hex chars at startup and fail fast. Delete the unused this.algorithm field.

<sub>Verifier: Verified: encryptTokens/decryptTokens use unauthenticated AES-256-CBC (TokenStorageService.js:300,342) while encryptString uses GCM (:582); docblock :563-566 admits CBC is weaker; this.algorithm (:19) is the only such reference repo-wide (truly dead); env key (:42) skips the :53-55 hex validation an</sub>

---

### 26. tool.script from config is joined into filesystem paths unvalidated — traversal-based arbitrary file read/write/delete

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `security` `sev:low`

**Files:**
- `server/routes/admin/tools.js:644`
- `server/routes/admin/tools.js:843`
- `server/routes/admin/tools.js:948`
- `server/routes/admin/tools.js:508`

**Problem:** GET/PUT /api/admin/tools/:toolId/script and DELETE /api/admin/tools/:toolId build `join(rootDir, 'server', 'tools', tool.script)` from the stored `script` field without resolveAndValidatePath. POST/PUT tool routes validate only `id` and `name`, so an admin (or tampered tools.json) can set `script: '../../contents/.encryption-key'` or '../../server/server.js' and then read, overwrite (PUT with arbitrary content), or delete (DELETE unlinks the script) any file on disk relative to server/tools. This violates the project's own api-security rule ('Validate stored config paths too') that skills.js and pages.js already follow.

**Evidence:** tools.js:948 `const scriptPath = join(rootDir, 'server', 'tools', tool.script); ... await fs.writeFile(scriptPath, content, 'utf-8');` — no path validation. tools.js:643-647 unlinks the same unvalidated join. tools.js:400 create/update validation: `if (!updatedTool.id || !updatedTool.name)` only.

**Recommended fix:** Run tool.script through resolveAndValidatePath against server/tools (rejecting on null) in all three handlers, and validate the script field on create/update (e.g. /^[a-zA-Z0-9_-]+\.js$/).

<sub>Verifier: Code verified: tools.js:843/948/644 join tool.script into paths and read/write/unlink with no resolveAndValidatePath; POST/PUT validate only id/name (:508/:400); no schema validates script. pages.js:59 and skills.js:145 follow the api-security rule; tools.js doesn't. But all routes are adminAuth-gat</sub>

---

## 🐛 Bugs & Correctness

### 27. Cancellation and node timeout cannot interrupt an in-flight LLM/tool loop

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:high`

**Files:**
- `server/services/workflow/executors/PromptNodeExecutor.js:1435`
- `server/services/workflow/WorkflowLLMHelper.js:233`
- `server/services/workflow/WorkflowEngine.js:1554`

**Problem:** The core agent tool loop `executeLLMWithTools` never checks `context.abortSignal.aborted`, and `WorkflowLLMHelper.executeStreamingRequest`/`throttledFetch` are called with no `signal`. `WorkflowEngine._executeWithTimeout` rejects on timeout but does not abort the wrapped `executor.execute()`. Consequently `engine.cancel()`, the per-node timeout, and the wall-time deadline can only take effect BETWEEN nodes — a single agent node keeps issuing LLM calls, running tools, and mutating shared `state.data` (citations, task queue, artifacts on disk) until it finishes naturally. A cancelled or timed-out research run keeps burning budget and can write state after the engine marked the run FAILED/CANCELLED.

**Evidence:** executeLLMWithTools loop `while (iteration < maxIterations)` (PromptNodeExecutor.js:1495) has no abort check; executeStreamingRequest calls `throttledFetch(model.id, request.url, { method, headers, body })` (WorkflowLLMHelper.js:273) with no signal. `_executeWithTimeout` only `reject(error)`s on the timer (WorkflowEngine.js:1556-1560) — fn() keeps running. context.abortSignal is wired (WorkflowEngine.js:932) and used by LoopNodeExecutor/CorpusSearch but ignored by the prompt loop.

**Recommended fix:** Thread `context.abortSignal` into `executeStreamingRequest` (pass `signal` to throttledFetch) and check `signal.aborted` at the top of each tool-loop iteration and before each tool call. Have `_executeWithTimeout` create/trigger an AbortController on timeout so the underlying request is actually torn down.

<sub>Verifier: Verified all claims. executeLLMWithTools loop (PromptNodeExecutor.js:1495-1802) has zero abortSignal checks; mutates state.data (citations ~1602, budget 1633). executeStreamingRequest passes no signal to throttledFetch (WorkflowLLMHelper.js:273). _executeWithTimeout only reject()s the timer; fn()=ex</sub>

---

### 28. Office add-in manifest.xml endpoint always 500s (undefined variables)

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:high`

**Files:**
- `server/routes/integrations/officeAddin.js:453`
- `server/routes/integrations/officeAddin.js:457`

**Problem:** In `generateManifest`, the V1_1 Resources block interpolates `${escapeXml(displayName)}` and `${escapeXml(description)}`, but no `displayName` or `description` variable exists in scope — the function only defines `displayNameEn/De` and `descriptionEn/De`. Because these are inside an eagerly-evaluated template literal, the whole function throws `ReferenceError: displayName is not defined` on every call. The `/api/integrations/office-addin/manifest.xml` handler has no try/catch, so it returns HTTP 500 whenever Office integration is enabled — the manifest users must install the add-in with cannot be generated at all.

**Evidence:** generateManifest signature (line 151) destructures `{ baseUrl, origin, displayNameEn, displayNameDe, descriptionEn, descriptionDe, showTaskPaneLabelEn, showTaskPaneLabelDe }`. Line 453: `<bt:String id="GroupLabel" DefaultValue="${escapeXml(displayName)} Add-in"/>` and line 457: `DefaultValue="${escapeXml(description)}"`. Grep confirms no `displayName`/`description` binding exists in the file.

**Recommended fix:** Replace `displayName`→`displayNameEn` and `description`→`descriptionEn` (or add German overrides like the earlier blocks). Add a test that GETs the manifest so this regression is caught.

<sub>Verifier: Verified officeAddin.js:453 uses `${escapeXml(displayName)}` and :457 uses `${escapeXml(description)}`. generateManifest (lines 151-160) only defines displayNameEn/De, descriptionEn/De; grep confirms no bare displayName/description binding exists (other hits are JSDoc). The single eager template lit</sub>

---

### 29. Protected-group list uses wrong IDs — the real 'admins' group can be deleted, locking out all admins

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:high`

**Files:**
- `server/routes/admin/groups.js:830`
- `server/defaults/config/groups.json`

**Problem:** DELETE /api/admin/groups/:groupId refuses to delete 'protected system groups' `['admin', 'user', 'anonymous', 'authenticated']`, but the shipped groups are `admins` and `users`. The guard protects two nonexistent IDs while the real `admins` group — the only one with `adminAccess: true` — is deletable with one API call. After deletion no group grants adminAccess, and adminAuth's fallback only triggers when loadGroupsConfiguration throws, so every admin is locked out until someone hand-edits groups.json. PUT has no protection either (adminAccess can be stripped from 'admins'), and neither POST nor PUT accepts/preserves the documented `inherits` field.

**Evidence:** groups.js:830 `const protectedGroups = ['admin', 'user', 'anonymous', 'authenticated'];` vs server/defaults/config/groups.json keys `['admins', 'users', 'anonymous', 'authenticated']` (admins has adminAccess=true). adminAuth.js:60 fallback `['admin', 'admins']` runs only in the catch branch.

**Recommended fix:** Fix the list to the shipped IDs ('admins', 'users', ...), or better: refuse to delete/update any group that is the last one with adminAccess (mirroring the isLastAdmin guard in admin/auth.js users DELETE).

<sub>Verifier: Verified: groups.js:830 lists protectedGroups=['admin','user',...] but shipped groups.json keys are 'admins'/'users'; 'admins' (only adminAccess:true group) is deletable (line 831 passes, 865 deletes). adminAuth.js:41-53 then denies everyone; the ['admin','admins'] fallback (line 60) only runs in ca</sub>

---

### 30. Fix copy-pasted `error: err`/`error: e` in ~19 catch blocks — error paths throw ReferenceError, crashing auth, chats, streams, and the process

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:high`

**Files:**
- `server/middleware/proxyAuth.js:21`
- `server/middleware/proxyAuth.js:44`
- `server/services/PromptService.js:378`
- `server/services/PromptService.js:406`
- `server/services/PromptService.js:425`
- `server/adapters/toolCalling/OpenAIConverter.js:385`
- `server/adapters/toolCalling/AnthropicConverter.js:279`
- `server/services/UsageEventLog.js:32`
- `server/services/UsageEventLog.js:143`
- `server/services/UsageEventLog.js:151`
- `server/services/UsageAggregator.js:174`
- `server/services/UsageAggregator.js:215`
- `server/usageTracker.js:172`
- `server/shortLinkManager.js:54`
- `server/routes/shortLinkRoutes.js:121`
- `server/routes/admin/configs.js:355`
- `server/services/integrations/Office365Service.js:966`
- `server/services/marketplace/ContentInstaller.js:245`
- `server/services/marketplace/ContentInstaller.js:281`

**Problem:** Recurring copy-paste bug: `catch (error)` blocks log `error: err` or `error: e`, so the handler itself throws ReferenceError. Consequences by site: proxyAuth JWKS/JWT verification failures escape as unhandled rejections (no unhandledRejection handler registered — request hangs; on Node >=15 the process can die); PromptService's non-fatal skills/styles fallbacks fail whole chat requests; converter tool-argument parse recovery aborts streams and leaks streaming state; usage flush/rollup, short-link save/redirect, admin platform-config save (audit entry lost), Office365 drive listing, and ContentInstaller companion fetches crash instead of degrading. proxyAuth's hand-rolled jwksCache additionally never expires, breaking IdP key rotation.

**Evidence:** proxyAuth.js:20-23 `} catch (error) { logger.error('Error fetching JWKs', { component: 'ProxyAuth', error: err }); return null; }` — `err` undefined; verifyJwt awaited outside any try/catch (proxyAuth.js:101). Same pattern at proxyAuth.js:44, PromptService.js:378/406/425, OpenAIConverter.js:385, AnthropicConverter.js:279, UsageEventLog.js:32/143/151, UsageAggregator.js:174/215, usageTracker.js:172, shortLinkManager.js:54, shortLinkRoutes.js:121, configs.js:355, Office365Service.js:966, ContentInstaller.js:245/281. `grep -rn unhandledRejection server/` matches only sea-server.cjs. proxyAuth.js:10 `const jwksCache = new Map();` — no TTL (teamsAuth.js uses jwks-rsa with 10h cache).

**Recommended fix:** Mechanically rename the logged variable to the bound catch parameter at all sites; enable/verify ESLint no-undef on server code so this class cannot ship again; add a process-level unhandledRejection handler in server.js; replace proxyAuth's hand-rolled JWKS fetching with a TTL'd jwks-rsa client shared with teamsAuth.

<sub>Verifier: All 19 sites verified: each has `catch (error)` but logs `error: err`/`error: e` (undefined). ES modules are strict → ReferenceError thrown inside the catch. proxyAuth.js:21,44 — `grep \berr\b` shows `err` never declared; verifyJwt awaited at :101 outside the :183 try, so it escapes the async middle</sub>

---

### 31. Default WORKERS=4 clustering runs one-time bootstrap and file-writing schedulers in every worker — racy migrations and clobbered JSON state

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:high`

**Files:**
- `server/config.js:57`
- `server/server.js:202`
- `server/server.js:218`
- `server/server.js:226`
- `server/server.js:355`
- `server/migrations/runner.js:227`
- `server/migrations/runner.js:256`
- `server/services/UsageAggregator.js:167`
- `server/usageTracker.js:126`
- `server/shortLinkManager.js:27`
- `server/clusterSticky.js:68`
- `docker/docker-compose.prod.yml:85`
- `docs/scaling.md:127`

**Problem:** WORKERS defaults to 4; every worker runs the full bootstrap: performInitialSetup, runConfigMigrations, rollup/audit schedulers, MCP connectAll. The migration lock is read-then-write (no 'wx' flag), so simultaneously forked workers all run migrations concurrently — racing read-modify-writes on platform.json and .migration-history.json; losers' 'Migration lock held' errors, and even onFailure:'halt', are caught by server.js and downgraded to warnings, so halt never halts. usageTracker/shortLinkManager cache JSON per-process (a short link created on worker A 404s on worker B); four rollup schedulers write the same files non-atomically. Sticky routing hashes remoteAddress, so behind a proxy all traffic hits one worker anyway.

**Evidence:** config.js:57 `WORKERS: env.WORKERS ?? env.NUM_WORKERS ?? 4`. server.js:167-386 else-branch per worker calls performInitialSetup (:202), runConfigMigrations (:218), startRollupScheduler (:355), startAuditCleanupScheduler (:383); server.js:226-229 downgrades halt to 'Server will continue, but configuration may be outdated'. runner.js:227-256 acquireLock: fs.readFile catch ENOENT → fs.writeFile — no 'wx' flag. usageTracker.js:126 `if (usage) return usage`; shortLinkManager.js:28 `if (links) return links`; UsageAggregator.js:167 unguarded fs.writeFile from per-worker setInterval. clusterSticky.js:13 'hashed by remoteAddress'.

**Recommended fix:** Run one-time bootstrap (setup, migrations, schedulers, MCP eager connect) only in the primary or WORKER_INDEX===0; use fs.writeFile(lockPath, data, {flag:'wx'}) for the migration lock; exit the process when onFailure:'halt' fires; default WORKERS=1 until per-worker file state is made worker-safe.

<sub>Verifier: Verified every claim. config.js:57 & docker-compose.prod.yml:85 → default WORKERS=4. server.js:81 primary only forks; else-branch (202,218,355,369,383) runs full bootstrap in EACH worker. runner.js:227-256 lock is TOCTOU: ENOENT swallowed (244), then non-atomic fs.writeFile (256), no 'wx'. server.js</sub>

---

### 32. Fix cross-request tool-call state contamination: streaming converters share a single 'default' state for all chats

**Severity:** high · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:high`

**Files:**
- `server/adapters/toolCalling/OpenAIConverter.js:246`
- `server/adapters/toolCalling/AnthropicConverter.js:159`
- `server/adapters/toolCalling/VLLMConverter.js:246`
- `server/adapters/BaseAdapter.js:234`
- `server/services/chat/ToolExecutor.js:925`

**Problem:** OpenAI/Anthropic/vLLM converters keep streaming tool-call accumulation in a module-level Map keyed by streamId, but the main chat pipeline never passes one: BaseAdapter.parseSseStream and ToolExecutor call convertResponseToGeneric(evt.data, provider), so every concurrent chat shares streamingState.get('default'). Two users streaming tool calls simultaneously overwrite/concatenate each other's pending id/name/arguments (Anthropic has a single state.pendingToolCall), executing corrupted or cross-user tool calls. State is only deleted on finish_reason/message_stop — an aborted stream leaves stale pendingToolCalls that the NEXT unrelated request finalizes as ghost tool calls.

**Evidence:** OpenAIConverter.js:246-258 `const streamingState = new Map(); ... convertOpenAIResponseToGeneric(data, streamId = 'default')`; BaseAdapter.js:234 `await convertResponseToGeneric(evt.data, provider)` (no streamId); ToolExecutor.js:925 and 1326 same; AnthropicConverter.js:255 `state.pendingToolCall = {...}` (singular, overwritten by any concurrent stream); OpenAIConverter.js:375 finalizes ALL entries in shared state on any stream's finish. openaiProxy.js:329 already shows the fix pattern: `const streamId = completionId;`.

**Recommended fix:** Thread ctx.chatId (already available in parseResponseStream ctx) through parseSseStream into convertResponseToGeneric as streamId, same in ToolExecutor. Add state cleanup on stream error/abort (finally block or TTL) so aborted streams cannot leak pending tool calls into later requests.

<sub>Verifier: Verified: converters keep module-level streamingState Maps (OpenAIConverter.js:246, AnthropicConverter.js:159, VLLMConverter.js:246), all default streamId='default' (ToolCallingConverter.js:142). Main pipeline never passes one (BaseAdapter.js:234; ToolExecutor.js:925,1326), so concurrent chats share</sub>

---

### 33. Fix duplicate migration version numbers V018 and V043 (one is a security fix)

**Severity:** high · **Confidence:** 🟡 evidence-backed (final pass pending) · **Effort:** medium  
**Labels:** `bug` `sev:high`

**Files:**
- `server/migrations/V018__add_cookie_settings.js:12`
- `server/migrations/V018__add_setup_configured_flag.js:1`
- `server/migrations/V043__add_content_admin_group.js:11`
- `server/migrations/V043__fix_ifinder_jwt_subject_template.js:24`
- `server/migrations/runner.js:120`
- `server/migrations/runner.js:349`
- `server/migrations/runner.js:354`

**Problem:** Two migration pairs share a version: V018 (add_cookie_settings / add_setup_configured_flag) and V043 (add_content_admin_group / fix_ifinder_jwt_subject_template — the iFinder JWT subject leak security fix). The runner keys everything by version alone: pending filtering via `appliedVersions.has(f.version)` means an install that already recorded one '018'/'043' will silently NEVER apply the sibling — the security fix can be skipped on upgrades. `filesByVersion = new Map(...)` collapses duplicates, guaranteeing spurious 'Checksum mismatch' warnings on every startup (default 'warn') and a hard startup failure under checksumValidation 'strict'.

**Evidence:** V018__add_cookie_settings.js:12 and V018__add_setup_configured_flag.js:1 both `export const version = '018'`; the V043 pair both export '043'. runner.js:120 `const filesByVersion = new Map(migrationFiles.map(f => [f.version, f]))` — last duplicate wins, so the other file's history entry always mismatches its checksum (runner.js:137-143). runner.js:354 `const pending = migrationFiles.filter(f => !appliedVersions.has(f.version))`. V061__centralize_credentials.js:3 comment 'Numbered V060 (not V057): main already ships V057–V059' shows the collision problem is recurring.

**Recommended fix:** Renumber the later duplicate of each pair to a fresh version (with a one-time history reconciliation), make scanMigrationFiles throw on duplicate version numbers so this can never ship again, and add a CI check. Consider keying history/checksums on version+description.

---

### 34. Form submission uses document.querySelector('form') instead of formRef in AppChat

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/apps/pages/AppChat.jsx:1117`
- `client/src/features/apps/pages/AppChat.jsx:776`

**Problem:** handleResendMessage and the voice-command sendMessage dispatch a submit event to `document.querySelector('form')` — the first form in the whole document — even though formRef is available and used elsewhere in the same file (492, 1018). In embedded contexts or any layout with more than one form on the page, this targets the wrong form and either no-ops or submits unrelated inputs.

**Evidence:** AppChat.jsx:1116-1123 `const form = document.querySelector('form'); if (form) { ... form.dispatchEvent(submitEvent); }` and identical pattern at 775-783; contrast with 492 `formRef.current.dispatchEvent(...)` and 1017-1018 `formRef.current.requestSubmit()`.

**Recommended fix:** Use formRef.current.requestSubmit() consistently in all four sites and drop the querySelector lookups.

<sub>Verifier: Code matches exactly: AppChat.jsx:1116-1123 (in handleResendMessage) and 776-783 (voice-command sendMessage) both use document.querySelector('form') (first form document-wide), while formRef (defined :348, attached to chat form in ChatInput.jsx:520-521) is used correctly at :492-493 and :1017-1018. </sub>

---

### 35. 5xx error placeholder poisons the API cache and is returned to callers as data

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/api/utils/requestHandler.js:132`
- `client/src/api/utils/requestHandler.js:21`

**Problem:** On any 5xx, handleApiResponse stores `{ error, isErrorPlaceholder: true, status }` under the same cacheKey as real data. The cache-hit path returns `cachedData.data !== undefined ? cachedData.data : cachedData` — the placeholder has no .data, so the placeholder object itself is returned as a successful response for the next 60 seconds. No caller anywhere checks isErrorPlaceholder (single grep hit is the definition), so after one transient 500 on e.g. /styles or /configs/ui, components receive `{error: ..., status: 500}` where they expect arrays/objects and crash or render blank instead of showing an error/retrying.

**Evidence:** requestHandler.js:132-139 `if (error.response?.status >= 500 && cacheKey) { const errorPlaceholder = { error: enhancedError.message, isErrorPlaceholder: true, status: ... }; cache.set(cacheKey, errorPlaceholder, DEFAULT_CACHE_TTL.SHORT); }` and :21-25 `if (cachedData && !handleETag) { return cachedData.data !== undefined ? cachedData.data : cachedData; }`. `grep -rn isErrorPlaceholder client/` → only requestHandler.js:135.

**Recommended fix:** Delete the error-placeholder caching (the deduplication map already limits request storms), or if negative caching is wanted, check isErrorPlaceholder on the cache-hit path and re-throw the stored error instead of returning it as data.

<sub>Verifier: Verified in code. requestHandler.js:132-138 caches `{error,isErrorPlaceholder,status}` under cacheKey (TTL SHORT=60s, cache.js:207). On next call, requestHandler.js:21-24 returns it as resolved data: cache.js:55-63 returns cachedItem.value (no .data), and line 24 falls through to `cachedData`. grep </sub>

---

### 36. In-run node retries consume the per-node cycle-guard budget

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/workflow/WorkflowEngine.js:606`
- `server/services/workflow/WorkflowEngine.js:865`

**Problem:** The retry loop in `_runExecutionLoop` re-invokes `executeNode` for each attempt, and `executeNode` increments `state.data._nodeIterations[nodeId]` on every call, throwing MAX_NODE_ITERATIONS_EXCEEDED once it passes `workflow.config.maxIterations`. The code explicitly documents (in resumeFromTerminated:1367 and resumeFromCheckpoint:405) that this counter is a CYCLE guard, not a retry counter — yet the in-run retry path bumps it. With `node.execution.retries` configured and a modest maxIterations (default 10), retries silently eat the loop budget and can trip the cycle cap prematurely, or interact badly with loop nodes reusing the same node id.

**Evidence:** Retry loop WorkflowEngine.js:606-653 calls `this.executeNode(...)` per attempt; executeNode:866-880 does `currentIteration = (nodeIterations[nodeId]||0)+1` then throws if `> maxIterations`. No retry-vs-cycle distinction in that increment.

**Recommended fix:** Track retries separately from the cycle counter — e.g. decrement/skip the _nodeIterations bump on a retry attempt, or key the cycle guard on successful completions rather than every executeNode entry.

<sub>Verifier: Verified: retry loop (WorkflowEngine.js:606-653) re-calls executeNode per attempt; executeNode (866-898) increments and PERSISTS _nodeIterations at line 887-898 BEFORE the executor runs (944), so failed attempts accumulate the count, with the cap throw at 870. Grep confirms no in-run reset — only re</sub>

---

### 37. Plan reconciliation skipped on timeout and max-iteration failure paths

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/workflow/WorkflowEngine.js:511`
- `server/services/workflow/WorkflowEngine.js:753`
- `server/services/workflow/WorkflowEngine.js:1630`

**Problem:** `_reconcilePlanOnTerminal` (which flips leftover `in_progress`/`open` tasks to `cancelled` so a finished run has no perpetually-spinning tasks) is invoked from `_completeWorkflow` and `_handleNodeError`, but NOT from the two other terminal transitions: the maxExecutionTime deadline handler (511-540) and the MAX_EXECUTION_ITERATIONS handler (753-777). Agent runs that die by wall-time budget or iteration cap therefore render with tasks stuck spinning in the UI — the exact bug reconciliation exists to prevent — just via a different exit path.

**Evidence:** Deadline block (WorkflowEngine.js:516-538) and max-iterations block (761-776) call `stateManager.update({status: FAILED})` + `addError` + `checkpoint` but never `await this._reconcilePlanOnTerminal(executionId)`, unlike _handleNodeError:1053 and _completeWorkflow:1098.

**Recommended fix:** Call `await this._reconcilePlanOnTerminal(executionId)` before persisting FAILED in both the deadline and max-iteration branches (ideally extract a single `_failRun(executionId, code, message)` helper used by all failure paths).

<sub>Verifier: Verified: `_reconcilePlanOnTerminal` (def WorkflowEngine.js:1630) is called only from `_handleNodeError`:1053 and `_completeWorkflow`:1098. The deadline handler (510-540) and max-iterations handler (754-777) set FAILED + addError + checkpoint + emit but never reconcile. Reachable: agent runs populat</sub>

---

### 38. Prompt template substitution breaks on regex metacharacters in variable keys and '$' patterns in user content

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/PromptService.js:193`
- `server/services/PromptService.js:197`
- `server/services/PromptService.js:331`

**Problem:** Variable substitution builds `new RegExp('\\{\\{' + key + '\\}\\}', 'g')` from unescaped, client-supplied variable keys (msg.variables comes from the request body) — a key like `foo(` throws SyntaxError and fails the whole chat request. Worse, all replacements pass raw values as the String.replace replacement string, where `$&`, `$'`, `` $` `` are special: line 193 injects the user's chat message as `content`, so a user typing `$&` into an app using a `{{content}}` template gets a corrupted prompt. The same applies to the `{{sources}}` substitution when source content contains `$` patterns.

**Evidence:** PromptService.js:193 `const variables = { ...globalPromptVariables, ...msg.variables, content: msg.content };` then 197-199 `processedContent = processedContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), strValue);` — key unescaped, strValue used as replacement pattern. Same pattern at 241-244, 272, and literal replace at 331 `systemPrompt.replace('{{sources}}', sourceContent || '')`.

**Recommended fix:** Use a single template helper that escapes regex metacharacters in keys and passes a function replacement (`.replace(re, () => strValue)`) to disable $-pattern interpretation. The same substitution loop is written 4 times in this file — consolidate it.

<sub>Verifier: Code matches exactly: PromptService.js:193/197-200 build `new RegExp` from unescaped keys and use raw values as replacement strings; :331 same for sources. chatPostSchema (validators/index.js:69) is `messages: z.array(z.any())` — no key/shape validation, so the user/promptTemplate/variables branch i</sub>

---

### 39. InMemorySink leaks a fire-sse listener on the actionTracker singleton for every non-tools App-as-tool invocation

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/chat/streamSink/InMemorySink.js:164`
- `server/services/chat/ChatService.js:308`

**Problem:** invokeAppInternal always calls sink.startListening() (registers a listener on the shared actionTracker EventEmitter). For apps without tools, the response arrives via the res-shim (NonStreamingHandler writes res.json), and getResult takes the early-return branch `if (this.jsonBody && this.chunks.length === 0 && !this.done) return this._assembleNonStreamingResult();` — which never calls stopListening(). stopListening only runs on the streaming path or in invokeAppInternal's catch. Every successful non-tools app invocation therefore leaves a permanent listener holding the sink alive: max-listener warnings, growing heap, and dead-listener iteration on busy agent servers.

**Evidence:** InMemorySink.js:162-171 — both early returns precede `this.stopListening()` at line 185; ChatService.js:308-320 non-tools path calls processNonStreamingChat then sink.getResult with no stopListening on success.

**Recommended fix:** Call this.stopListening() at the top of getResult (or in a finally), and have invokeAppInternal stop the sink in a finally block instead of only in catch.

<sub>Verifier: Traced concretely. invokeAppInternal (ChatService.js:262) always registers a fire-sse listener on the shared actionTracker singleton (InMemorySink.js:140; actionTracker.js:125, default maxListeners 10). Non-tools path (ChatService.js:308) → NonStreamingHandler.js:171 sets jsonBody, emits no events →</sub>

---

### 40. Per-chatId Maps leak for the process lifetime; answer-source badge never emitted when a tools app answers without calling tools

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/chat/ToolExecutor.js:30`
- `server/services/chat/ToolExecutor.js:1023`
- `server/services/PromptService.js:16`

**Problem:** ToolExecutor (a singleton) holds clarificationCounts and knowledgeSources Maps keyed by chatId. resetClarificationCount has zero callers, so counts accumulate forever. resetKnowledgeSources runs only on continueWithToolExecution's happy final-response path; the early returns when the model answers without tool calls, and all error paths, skip both the reset AND trackAnswerSource — so email/file answer-source badges are never emitted in the most common case, despite a comment claiming this exact bug was fixed. PromptService's module-level promptKnowledgeSources Map leaks the same way; StreamingHandler's Map leaks on its error path.

**Evidence:** grep: `resetClarificationCount` defined at ToolExecutor.js:64, never invoked anywhere in the repo. processChatWithTools early return at 1030-1042 calls trackDone/logInteraction but neither trackAnswerSource nor resetKnowledgeSources, while continueWithToolExecution's final-response path (1399-1417) does both.

**Recommended fix:** Emit answer-source and reset all per-chat state in one shared finalizer invoked from every terminal path (done/clarification/passthrough/error), and add TTL-based cleanup (or reuse the bounded-Map pattern from searchCache.js) for per-chatId Maps.

<sub>Verifier: Verified in code. ChatService.js:198 routes tools apps to ToolExecutor.processChatWithTools. Email/file sources added at ToolExecutor.js:833-838, but the no-tool-call early return (1023, block 1030-1042) skips both trackAnswerSource and resetKnowledgeSources; the only such call is 1399-1417, reachab</sub>

---

### 41. App-as-tool `variables` are silently dropped by ChatService.prepareChatRequest

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/chat/ChatService.js:21`
- `server/services/chat/ChatService.js:283`
- `server/agents/runtime/appAsToolGateway.js:166`

**Problem:** appAsToolGateway builds `variables` from tool-call args and passes them to chatService.invokeAppInternal, which forwards `variables` to this.prepareChatRequest. But ChatService.prepareChatRequest destructures a fixed parameter list (lines 22-44) that does not include `variables`, and RequestBuilder.prepareChatRequest doesn't accept it either — the value is silently discarded. Apps that define input variables and are invoked as agent tools get an unprocessed system/user prompt: `{{variable}}` placeholders are never substituted (PromptService only picks up variables from `lastUserMessage.variables`, which the gateway never sets).

**Evidence:** ChatService.js:283 passes `variables` into `this.prepareChatRequest({... chatId, variables })` while prepareChatRequest's destructure (ChatService.js:22-44) lists appId..chatId with no `variables`; RequestBuilder.js:115-138 likewise. PromptService.js:255-258 reads variables only from `messages.findLast(msg => msg.role === 'user').variables`.

**Recommended fix:** In invokeAppInternal, attach variables to the user message (`messages[last].variables = variables`) or thread `variables` through prepareChatRequest → RequestBuilder → processMessageTemplates. Add a test invoking an app with variables via the gateway.

<sub>Verifier: Verified full chain. appAsToolGateway.js:166 builds `variables` and passes to invokeAppInternal, which forwards it (ChatService.js:282). But ChatService.prepareChatRequest destructure (ChatService.js:22-44) omits `variables` and rebuilds the call (46-69) without it. RequestBuilder.js:115-138 also om</sub>

---

### 42. Tool-enabled chats record no usage tokens, telemetry spans, or stream-outcome metrics

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/chat/ToolExecutor.js:1`
- `server/services/chat/StreamingHandler.js:271`

**Problem:** StreamingHandler.executeStreamingResponse records usage (recordChatRequest, recordChatResponse), OTel LLM spans, app-usage/conversation metrics, and stream outcomes. ToolExecutor.processChatWithTools / continueWithToolExecution — the path taken whenever an app has tools — records none of this: the file imports neither usageTracker nor any telemetry module. Result: every tool-enabled app is invisible in usage tracking, token accounting, and gen_ai metrics dashboards, and the numbers admins see systematically undercount, worse the more tool loops run (each iteration is a full LLM call).

**Evidence:** ToolExecutor.js imports (lines 1-14) contain no usageTracker/telemetry references; `grep -n "recordChat|usageTracker|telemetry" ToolExecutor.js` returns nothing. StreamingHandler.js:271 `await recordChatRequest({...})`, 487 `await recordChatResponse({...})`, 300-320 instrumentation.createLLMSpan.

**Recommended fix:** Move usage/telemetry recording into a shared per-LLM-call wrapper used by both handlers (natural byproduct of extracting the shared streaming loop), so every LLM round-trip in the tool loop is counted.

<sub>Verifier: ToolExecutor.js (imports 1-14) has no usageTracker/telemetry/metrics imports; grep for recordChat*/estimateTokens/executeStreamingResponse returns nothing. StreamingHandler.js records recordChatRequest(271), recordAppUsage/Conversation(293-294), createLLMSpan(306), recordChatResponse(487), recordStr</sub>

---

### 43. OpenAI Responses non-streaming parsers match a nonexistent `item.function` shape — tool calls silently dropped

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/adapters/openai-responses.js:296`
- `server/adapters/toolCalling/OpenAIResponsesConverter.js:493`

**Problem:** In the OpenAI Responses API, non-streaming `output` items of type function_call are flat: `{ type: 'function_call', id, call_id, name, arguments }`. Both the adapter's processResponseBuffer and the converter's full-response branch guard on `item.type === 'function_call' && item.function` and read `item.function.name`/`item.function.arguments` — properties that never exist — so tool calls in any non-streaming Responses payload are silently discarded (the model appears to just stop). The streaming branch reads the correct flat fields, proving the two paths were written against different API versions. The adapter also uses `item.id` (fc_…) instead of `call_id` (call_…).

**Evidence:** openai-responses.js:296-306 `} else if (item.type === 'function_call' && item.function) { result.tool_calls.push({ id: item.id, ..., function: { name: item.function.name, arguments: item.function.arguments } });`. OpenAIResponsesConverter.js:493 `else if (item.type === 'function_call' && item.function)`. Correct handling exists at OpenAIResponsesConverter.js:404-414: `id: parsed.item.call_id || parsed.item.id, ... name: parsed.item.name`.

**Recommended fix:** In both non-streaming branches, read `item.name` / `item.arguments` directly and use `item.call_id || item.id` as the call id, mirroring the response.output_item.done handler. Ideally delete the adapter copy per the processResponseBuffer consolidation finding.

<sub>Verifier: Both guards exist verbatim (openai-responses.js:296, OpenAIResponsesConverter.js:493) reading nested item.function.*. The Responses function_call shape is flat, proven by the repo's own flat writer (openai-responses.js:37-42) and flat streaming readers (Converter 404-414/448-459/324). So item.functi</sub>

---

### 44. Google streaming: parallel function calls in separate chunks collide on index 0 and merge into one corrupted call

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/adapters/toolCalling/GoogleConverter.js:352`
- `server/services/chat/ToolExecutor.js:953`

**Problem:** GoogleConverter assigns each streamed functionCall an index of `result.tool_calls.length` — a counter that resets to 0 for every chunk because a fresh result object is created per SSE event. ToolExecutor deduplicates streamed tool calls by index (`collectedToolCalls.find(c => c.index === call.index)`). When Gemini emits multiple parallel function calls across separate streaming chunks (common for multi-tool turns), the second complete call matches the first's index 0: its id/name overwrite the first call and its full JSON arguments get concatenated onto the first call's arguments, producing invalid JSON like '{...}{...}' and losing a tool call entirely.

**Evidence:** GoogleConverter.js:352-358 `result.tool_calls.push(createGenericToolCall(`call_${result.tool_calls.length}_${Date.now()}`, ..., result.tool_calls.length, metadata))` — per-chunk counter. ToolExecutor.js:953 `let existingCall = collectedToolCalls.find(c => c.index === call.index);` then 975-977 `existingCall.function.arguments += callArgs;` concatenates the second call's complete arguments onto the first.

**Recommended fix:** Google function calls arrive complete (never as argument deltas), so either give them a monotonically increasing per-stream index (needs the per-stream state from the converter-state finding), or have ToolExecutor treat calls whose arguments are already complete JSON as new entries instead of merge candidates.

<sub>Verifier: GoogleConverter.js:210-211 builds a fresh result per SSE event, so tool_calls.length at :352-357 restarts at 0 each chunk; converter is stateless (_streamId unused), unlike OpenAIConverter.js:325 which keys pending calls by provider index. ToolExecutor.js:953 merges by index; :957/:962 overwrite id/</sub>

---

### 45. Provider-reported token usage is silently dropped for OpenAI-compatible streams despite requesting include_usage

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/adapters/BaseAdapter.js:237`
- `server/adapters/openai.js:135`
- `server/adapters/toolCalling/OpenAIConverter.js:358`
- `server/services/chat/StreamingHandler.js:484`

**Problem:** openai.js, vllm.js, and mistral.js request `stream_options: { include_usage: true }`, but OpenAI-compatible servers send the usage statistics in an extra chunk (empty choices) AFTER the chunk carrying finish_reason. The converter marks `complete: true` on the finish_reason chunk, and BaseAdapter.parseSseStream returns immediately on `result.complete`, so the usage chunk is never parsed. StreamingHandler then falls back to `estimateTokens(fullResponse)` with tokenSource 'estimate', making token accounting/billing telemetry inaccurate for all OpenAI, vLLM, and Mistral streaming chats — the include_usage request is wasted.

**Evidence:** openai.js:135-137 `if (stream && model.supportsUsageTracking !== false) { body.stream_options = { include_usage: true }; }`. OpenAIConverter.js:358-359 `if (parsed.choices && parsed.choices[0]?.finish_reason) { result.complete = true; ... }`. BaseAdapter.js:237 `if (result.error || result.complete) return;`. StreamingHandler.js:484-486 `accumulatedUsage?.completionTokens ?? estimateTokens(fullResponse); const tokenSource = accumulatedUsage ? 'provider' : 'estimate';`.

**Recommended fix:** For OpenAI-compatible providers, defer `complete` until the `[DONE]` sentinel (which the converter already handles), or continue draining queued events after complete until [DONE] so the trailing usage chunk is processed. Adjust StreamingHandler's break-on-complete accordingly.

<sub>Verifier: Verified: openai.js:135-137 requests include_usage; OpenAIConverter.js:358-359 sets complete=true on the finish_reason chunk (whose usage is null per OpenAI semantics); BaseAdapter.js:237 returns on complete, so the trailing usage-only chunk (empty choices) is never converted; StreamingHandler.js:48</sub>

---

### 46. Backup import deletes the live contents/ directory even when the safety backup failed

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/routes/admin/backup.js:320`
- `server/routes/admin/backup.js:332`

**Problem:** importConfig first copies contents/ to a timestamped backup dir, but on failure it only logs 'Could not backup current configuration' and continues (comment: 'Continue with import but warn user' — the user is never actually warned). It then runs `fs.rm(contentsPath, { recursive: true, force: true })` and copies the extracted archive in. If the safety copy failed (disk full, permissions) and the subsequent `fs.cp` also fails or the extracted ZIP is partial, the entire configuration — apps, models, users, groups, encryption keys — is unrecoverable. The rm/cp swap is also non-atomic: requests during the window see a half-populated contents dir.

**Evidence:** backup.js:320-326: `try { await fs.cp(contentsPath, currentBackupPath, ...) } catch (error) { logger.error('Could not backup current configuration'...); // Continue with import but warn user }` followed by backup.js:332 `await fs.rm(contentsPath, { recursive: true, force: true });`.

**Recommended fix:** Abort the import if the safety backup fails; stage the new contents next to the old and swap via rename (old → contents-backup, staged → contents) so there is no destructive window.

<sub>Verifier: backup.js:320-326 catches safety-backup cp failure, only logs, and continues; backup.js:332 then unconditionally rm -rf's contents/ before cp at 335, with no rollback in the outer catch (390) and the response (379) always reporting backupPath even when backup failed. Disk-full makes the safety cp fa</sub>

---

### 47. GET /api/admin/tools writes tools.json as a side effect and all tools.json mutations are non-atomic read-modify-write

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/routes/admin/tools.js:235`
- `server/routes/admin/tools.js:438`
- `server/routes/admin/tools.js:667`

**Problem:** The GET list endpoint rewrites config/tools.json whenever loadRawTools flags 'expanded tools' cleanup — a side-effectful GET that already caused one production regression (the V042/V045 comment at 138-152 documents how it silently wiped agent tools on every GET). All tools.json mutations (GET-cleanup, PUT, POST, DELETE, toggle) are unlocked read-modify-write cycles ending in plain fs.writeFile, so two concurrent admin requests (or an admin UI list-refresh racing a save) can clobber each other's changes, and a crash mid-write leaves a truncated tools.json. The repo already has atomicWriteJSON but tools.js never uses it.

**Evidence:** tools.js:235-240 inside the GET handler: `if (needsCleanup && filePath) { ... await fs.writeFile(filePath, JSON.stringify(tools, null, 2));`. tools.js:144 comment: "Without this carve-out, every GET on this endpoint wipes the agent tools from disk via the needsCleanup write below." tools.js:438/550/667/770 all `fs.writeFile(toolsFilePath, ...)` after an unsynchronized loadRawTools().

**Recommended fix:** Move the cleanup into a one-time migration (the V-migration system exists for this), make GET read-only, and use atomicWriteJSON plus a simple per-file mutex for tools.json mutations.

<sub>Verifier: Verified: GET handler writes tools.json as side effect (tools.js:235-240, plain fs.writeFile); comment at tools.js:144-145 documents the prior GET-wipes-agent-tools regression. PUT/POST/DELETE/toggle all do unsynchronized read-modify-write (loadRawTools at 422/531/633/756 → fs.writeFile at 438/550/6</sub>

---

### 48. Teams integration components crash on first render (TDZ) — feature is dead code

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/teams/TeamsTab.jsx:24`
- `client/src/features/teams/TeamsAuthStart.jsx:24`
- `client/src/features/teams/TeamsAuthEnd.jsx:20`
- `client/src/App.jsx:701`

**Problem:** All three Teams components reference `const` callbacks in useEffect dependency arrays before the const declarations execute, throwing `ReferenceError: Cannot access 'X' before initialization` the moment they render. TeamsWrapper (which wraps the whole app at App.jsx:701) renders TeamsTab whenever it detects a Teams host with an unauthenticated user, so the entire in-Teams experience white-screens. Further signs of rot: TeamsAuthStart uses CRA-style process.env.REACT_APP_AAD_CLIENT_ID (undefined under Vite, no `define` in vite.config.js) and TeamsAuthEnd.jsx:48 still contains a merge-conflict marker remnant.

**Evidence:** TeamsTab.jsx:22-27: `useEffect(() => { initializeTeams(); }, [initializeTeams]);` followed by `const initializeTeams = useCallback(...)` — the deps array evaluates the binding while in the temporal dead zone. Same pattern: TeamsAuthStart.jsx:24 `}, [buildAuthUrl]);` before line 26; TeamsAuthEnd.jsx:20 before line 22. TeamsAuthEnd.jsx:48: `// No token or error in the response<<<<<<< ISSUE_209_Microsoft_Teams`.

**Recommended fix:** Decide whether Teams support is real. If yes: rewrite the three components (declare callbacks before effects, use teams-js v2 promise APIs, replace process.env with import.meta.env) and add a smoke test. If no: delete client/src/features/teams/, the /teams/auth-* routes, and the TeamsWrapper wrapping in App.jsx.

<sub>Verifier: Verified all three files: deps arrays reference `const` callbacks declared later (TeamsTab.jsx:24 vs 27, TeamsAuthStart.jsx:24 vs 26, TeamsAuthEnd.jsx:20 vs 22). Array literals are evaluated when useEffect is called during render, reading the const in its TDZ → guaranteed ReferenceError. App.jsx:701</sub>

---

### 49. AppCanvas crashes on render: useCallback deps reference const bindings before declaration (TDZ)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/canvas/pages/AppCanvas.jsx:163`
- `client/src/features/canvas/pages/AppCanvas.jsx:239`

**Problem:** handlePromptSubmit's useCallback dependency array lists selectedText and editorContent, but those consts are only declared later by destructuring canvasHook (lines 288/295). The deps array is evaluated when useCallback runs (line 163), before the declarations, producing a Temporal Dead Zone ReferenceError ('Cannot access selectedText before initialization') on first render. No default app enables features.canvas and no test references AppCanvas, so this experimental page is currently dead/broken.

**Evidence:** Deps array at AppCanvas.jsx:236-250 includes `selectedText,` and `editorContent,`; declarations at 286-303 `const { content: editorContent, ... selectedText, ... } = canvasHook;`. Reproduced the exact ordering in Node: throws `ReferenceError: Cannot access 'selectedText' before initialization`.

**Recommended fix:** Either move the canvasHook destructure above handlePromptSubmit (and pass handlePromptSubmit into useCanvas via a ref/late binding), or read selectedText/editorContent from a ref inside the callback. If canvas is truly unused, delete the page/route instead.

<sub>Verifier: Verified in AppCanvas.jsx: useCallback deps array (lines 239-240) reads selectedText/editorContent, which are const-destructured only at 288/295 from canvasHook (283). useCallback evaluates its deps arg eagerly at line 163, before those consts initialize. Reproduced the exact ordering in Node: Refer</sub>

---

### 50. response.message.id handler calls undefined setMessages, silently breaking iAssistant feedback

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/chat/hooks/useAppChat.js:290`

**Problem:** The 'response.message.id' SSE handler calls setMessages(updatedMessages), but useAppChat never destructures setMessages from useChatMessages (it only exposes updateAssistantMessage, appendToAssistantMessage, etc.). This throws a ReferenceError inside the async handleEvent, so the assignment of message.ifinderMessageId never completes and messagesRef.current is never updated either (the throw precedes line 291). The server DOES emit this event (StreamingHandler.js:211) for iAssistant/iFinder responses, so feedback routing that reads message.ifinderMessageId always gets null.

**Evidence:** useAppChat.js:279-293 `case 'response.message.id': ... setMessages(updatedMessages); messagesRef.current = updatedMessages;`. Grep of the file shows setMessages appears only at line 290 and is never imported/destructured; useChatMessages.js return block (542-558) does not export setMessages. ChatMessage.jsx:422 reads message.ifinderMessageId for feedback routing.

**Recommended fix:** Add a race-safe updater to useChatMessages (e.g. setMessageFields(id, fields) using functional setMessages) and call it here instead of the undefined setMessages; drop the manual messagesRef mutation.

<sub>Verifier: Verified: useAppChat.js:290 calls setMessages, but it is never destructured from useChatMessages (53-68) nor exported by useChatMessages.js (542-558); grep shows it only at :290 → ReferenceError in strict-mode ESM, before :291. Server emits the event (StreamingHandler.js:211-213); ChatMessage.jsx:42</sub>

---

### 51. AdminAgentEditPage JSON mode is a controlled textarea that swallows keystrokes while JSON is momentarily invalid

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AdminAgentEditPage.jsx:373`

**Problem:** The JSON editing mode renders `<textarea value={JSON.stringify(profile, null, 2)} onChange={e => { try { setProfile(JSON.parse(e.target.value)); } catch { /* ignore */ } }} />`. Because the textarea is controlled by the re-serialized state, any keystroke that makes the JSON temporarily invalid (nearly every structural edit — adding a key, deleting a quote) is silently discarded and the text snaps back. JSON mode is effectively unusable and silently drops input; it also bypasses the TOP_LEVEL_FIELDS allowlist used by the form mode. Every other admin edit page uses the shared DualModeEditor, which buffers raw text.

**Evidence:** AdminAgentEditPage.jsx:371-383: `value={JSON.stringify(profile, null, 2)}` with onChange comment '// ignore parse errors while typing'.

**Recommended fix:** Replace the hand-rolled form/json toggle with the shared DualModeEditor (as in AdminAppEditPage/AdminModelEditPage), or at minimum keep a local rawText state that only commits to profile on valid parse/blur.

<sub>Verifier: Verified at AdminAgentEditPage.jsx:371-381: controlled textarea `value={JSON.stringify(profile,null,2)}`, onChange only setProfile on successful parse. Classic React revert bug — intermediate-invalid JSON keystrokes are discarded and snap back; structural edits unusable (only in-string edits/atomic </sub>

---

### 52. Surface server error details instead of generic axios messages; unify admin API error handling

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AdminAppsPage.jsx:206`
- `client/src/api/adminApi.js:98`
- `client/src/features/admin/pages/AdminAppEditPage.jsx:365`
- `client/src/features/admin/pages/AdminPromptEditPage.jsx:178`

**Problem:** 62 admin call sites use `setError(err.message)`, but makeAdminApiCall throws axios errors whose message is 'Request failed with status code N' — the server's real message (Zod validation details, conflict reasons) lives in err.response.data and is dropped. Proof it's broken: AdminAppsPage.jsx:206 checks `err.message.includes('already exists')` while the server sends that text only in the body, so the branch is dead and users always see the generic fallback. Only ~25 sites read err.response?.data. AdminAppEditPage:365 and AdminPromptEditPage:178 additionally replace the entire edit form with a full-page error on save failure.

**Evidence:** adminApi.js client interceptor (client/src/api/client.js:69-117) never rewrites error.message. AdminAppsPage.jsx:205-207 `if (err.message.includes('already exists'))` — unreachable with axios messages (server sends 'App with this ID already exists' only in the body, server/routes/admin/apps.js:740). AdminAppEditPage.jsx:333 `setError(err.message)` + line 365 `if (error) { return (<error page>) }` hides the whole form. Grep: 62 hits for `setError(err.message)` in features/admin.

**Recommended fix:** Add one `getAdminApiErrorMessage(err)` helper (prefer err.response?.data?.error || .message, fall back to err.message) inside or next to makeAdminApiCall; sweep the 62 call sites. Replace form-swallowing `if (error) return` blocks in edit pages with the inline banner pattern used by AdminModelEditPage.

<sub>Verifier: Core claim verified: adminApi.js:131 rethrows axios errors whose .message is "Request failed with status code N" (interceptor client.js:69-117 never rewrites it); server puts real text in body via sendErrorResponse ({error:message}, apps.js:740), so AdminAppsPage.jsx:206 'already exists' branch is d</sub>

---

### 53. Hardcoded '/api' URLs and raw fetch() bypass runtimeBasePath and apiClient auth, breaking subpath deployments

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `client/src/api/adminApi.js:62`
- `client/src/api/adminApi.js:125`
- `client/src/api/adminApi.js:687`
- `client/src/features/settings/pages/IntegrationsPage.jsx:93`
- `client/src/shared/components/CustomResponseRenderer.jsx:35`
- `client/src/features/admin/components/ArtifactViewer.jsx:25`
- `client/src/features/admin/pages/AdminProvidersPage.jsx:128`
- `client/src/features/auth/components/LoginForm.jsx:116`
- `client/src/features/nextcloud-embed/hooks/useNextcloudConnection.js:71`

**Problem:** The client transport derives its base via buildApiUrl() so subpath deployments (documented /ihub scenario) work, but many sites hardcode root-relative '/api': admin FormData uploads and skill export (adminApi's raw-fetch branch uses `VITE_API_URL || '/api'`), provider model tests, the entire Integrations page (8 fetches), custom response renderers in chat, agent artifact viewing, NTLM login redirect, and Nextcloud OAuth start. Under a subpath these all 404; raw fetch() also skips apiClient's Authorization interceptor, so token-based sessions call anonymously. adminApi.js:125's `pathname.startsWith('/admin')` is never true under a subpath, silently disabling the 403 redirect.

**Evidence:** adminApi.js:62-63 `const API_URL = import.meta.env.VITE_API_URL || '/api'; const fullUrl = `${API_URL}${axiosConfig.url}`;` (FormData branch uses fetch, not the base-path-aware apiClient); adminApi.js:687 same fallback for window.open; AdminProvidersPage.jsx:128 same. IntegrationsPage.jsx:93/107/137/150/171/177/207/239 `fetch('/api/integrations/...')` while line 82 correctly uses buildApiUrl. CustomResponseRenderer.jsx:35 `fetch(`/api/renderers/${componentName}`)`. LoginForm.jsx:116 hardcoded NTLM URL; useNextcloudConnection.js:71. Correct pattern: client.js:6 `buildApiUrl('')` plus Authorization injection at client.js:54-56.

**Recommended fix:** Route all of these through apiClient/makeAdminApiCall or buildApiUrl() (axios handles multipart if Content-Type is left unset — the raw-fetch FormData branch can be deleted); use getBasePath() for the '/admin' pathname check. Add an ESLint no-restricted-syntax rule banning literal '/api' strings outside runtimeBasePath.js.

<sub>Verifier: All 9 cited lines verified verbatim. Hardcoded '/api' (adminApi.js:62,687; IntegrationsPage.jsx:93+; CustomResponseRenderer.jsx:35; ArtifactViewer.jsx:25; AdminProvidersPage.jsx:128; LoginForm.jsx:116; useNextcloudConnection.js:71) bypasses buildApiUrl(), breaking the documented /ihub subpath model </sub>

---

### 54. UsageEventLog.flushQueue permanently drops buffered events when the disk write fails

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/UsageEventLog.js:15`

**Problem:** flushQueue clears the in-memory queue BEFORE awaiting fs.appendFile. If the append fails (ENOSPC, EACCES, transient IO error), the events are gone — there is no re-buffer and no retry. Sibling stores already solved this: feedbackStorage.appendQueueToDisk re-buffers on failure (`queue = pending.concat(queue); throw err;`) and AuditLogService re-buffers per-date with an overflow cap. Usage events feed the admin usage dashboards and rollups, so silent loss corrupts reporting. Combined with the `error: e` catch bug in the same file, the failure is not even logged — it crashes instead.

**Evidence:** server/services/UsageEventLog.js:15-23: `const lines = queue.map(entry => JSON.stringify(entry)).join('\n') + '\n'; queue = []; await fs.appendFile(eventFile, lines, 'utf8');` — queue emptied before the await, no catch/re-buffer. Contrast server/feedbackStorage.js:48-54 which re-buffers on append failure.

**Recommended fix:** Mirror feedbackStorage: capture pending entries, clear queue, and on appendFile failure re-buffer (`queue = pending.concat(queue)`) and rethrow. Add a bounded-queue cap like AuditLogService's MAX_QUEUE.

<sub>Verifier: Verified UsageEventLog.js:20-21: queue=[] runs before `await fs.appendFile`, with no catch/re-buffer — a failed append permanently drops the batch. Sibling contrast holds: feedbackStorage.js:52 (`queue=pending.concat(queue);throw err`) and AuditLogService.js:161 re-buffer on failure. The `error: e` </sub>

---

### 55. Blocked/deadlocked nodes leave the run stuck in RUNNING forever

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/services/workflow/WorkflowEngine.js:559`

**Problem:** In `_runExecutionLoop`, when the scheduler returns zero executable nodes but `currentNodes` is non-empty (a node blocked on an unsatisfiable dependency), the engine logs a warning and `break`s out of the loop WITHOUT setting a terminal status, recording an error, or emitting `workflow.failed`. The run remains in status RUNNING indefinitely, the ExecutionRegistry never updates, and no client is ever notified. Under AND-semantics DAG sub-workflows (allowCycles:false), a mis-declared `dependsOn` produces exactly this state (getExecutableNodes returns [] at DAGScheduler.js:320).

**Evidence:** WorkflowEngine.js:560-578: `if (executableNodes.length === 0) { if (state.currentNodes.length === 0) { await this._completeWorkflow(...) } else { logger.warn('Workflow has blocked nodes', ...) } break; }` — the else branch neither fails the run nor checkpoints; iterationCount is below MAX so the post-loop max-iterations handler is skipped too.

**Recommended fix:** In the blocked branch, mark the execution FAILED with a WORKFLOW_DEADLOCK error, checkpoint, update the registry, and emit workflow.failed before breaking — mirroring the deadline/max-iteration failure paths.

<sub>Verifier: Verified WorkflowEngine.js:560-577: blocked-nodes else branch only warns+breaks — no FAILED status, addError, workflow.failed, or checkpoint; state stays RUNNING (set 470-473). Max-iter handler (754) skipped since iterationCount<MAX; finally (802) only clears abort controller. Deadline (509) checked</sub>

---

### 56. GET /api/models/:modelId always 500s — transformModelToOpenAIFormat is undefined

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/routes/modelRoutes.js:152`

**Problem:** The single-model detail handler calls `transformModelToOpenAIFormat(model)` but that function is neither imported nor defined anywhere in the codebase (grep finds exactly one occurrence: the call site). At runtime this throws `ReferenceError: transformModelToOpenAIFormat is not defined`, which the surrounding try/catch converts into a 500. This documented public endpoint (Swagger'd, OpenAI-compat) is entirely non-functional for every valid, permitted model. The client's fetchModelDetails helper wraps it, so any consumer that starts calling it gets a hard failure.

**Evidence:** modelRoutes.js:152 `const transformedModel = transformModelToOpenAIFormat(model);` — no matching import in the file's import block (lines 1-10) and no definition anywhere (`grep -rn transformModelToOpenAIFormat server` returns only this line).

**Recommended fix:** Either implement/import transformModelToOpenAIFormat, or return the model object directly (`res.json(model)`) as the list endpoint does. Add a smoke test hitting GET /api/models/:modelId.

<sub>Verifier: modelRoutes.js:152 calls transformModelToOpenAIFormat(model); it's absent from the import block (lines 1-10) and grep across the repo (exact name, plus OpenAIFormat/toOpenAI variants) yields only this call site — no definition, global, or dynamic ref. modelAccessRequired (authRequired.js:91-111,128)</sub>

---

### 57. Fix Express route shadowing: /admin/prompts/app-generator and /admin/sources/_stats,_types are unreachable

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/routes/admin/prompts.js:402`
- `server/routes/admin/prompts.js:1358`
- `server/routes/admin/sources.js:550`
- `server/routes/admin/sources.js:1403`
- `server/routes/admin/sources.js:1471`
- `client/src/features/apps/components/AppCreationWizard.jsx:634`

**Problem:** GET /api/admin/prompts/:promptId (prompts.js:402) is registered before GET /api/admin/prompts/app-generator (prompts.js:1358), so the dedicated route never executes. The App Creation Wizard calls it expecting `{ prompt: "<resolved string>" }` but receives the raw prompt object where `prompt` is a localized map, which it sends as the system-message content — the AI app-generation step runs with a broken system prompt. Same pattern in sources.js: `/:id` shadows `/_stats` and `/_types` ('_stats' passes isValidId), so both always 404; grep shows no callers, so they are also dead code.

**Evidence:** prompts.js:402 `app.get(buildServerPath('/api/admin/prompts/:promptId')...` precedes prompts.js:1358 `app.get(buildServerPath('/api/admin/prompts/app-generator')...`. defaults/prompts/app-generator.json has `prompt` as an object. AppCreationWizard.jsx:681 `content: appGeneratorPrompt.prompt`. sources.js:550 `/:id` precedes 1403 `/_stats` and 1471 `/_types`; pathSecurity.js:20 SAFE_ID_PATTERN allows underscores. apps.js registers `/templates` before `/:appId` (the correct pattern).

**Recommended fix:** Register literal routes before parameterized ones (move app-generator above :promptId). Delete the uncalled _stats/_types/_dependencies endpoints or move them above /:id if they are wanted.

<sub>Verifier: Verified: prompts.js:402 /:promptId is registered before prompts.js:1358 /app-generator in the same function; app-generator passes SAFE_ID_PATTERN (pathSecurity.js:20, hyphens allowed) and exists (defaults/prompts/app-generator.json with prompt as {en,de} object), so line 402's res.json(prompt) shad</sub>

---

### 58. Request-scoped base path stored on global.currentRequest — cross-request race in URL generation

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/utils/basePath.js:237`
- `server/utils/basePath.js:25`
- `server/utils/publicBaseUrl.js:72`

**Problem:** basePathDetectionMiddleware stores the live request in a process-wide global; getBasePath() later reads X-Forwarded-Prefix from it. Any await between middleware and the point where a handler builds a URL lets a concurrent request overwrite global.currentRequest, so PWA manifests, Office add-in manifests, OAuth callback URL builders (buildPublicBaseUrl) and short links can be generated with ANOTHER request's prefix — including an attacker-supplied X-Forwarded-Prefix from a parallel request. It also pins the last request/response objects in memory forever. The project already has an AsyncLocalStorage request context (utils/requestContext.js) that is the correct home for this.

**Evidence:** basePath.js:236-239 `export const basePathDetectionMiddleware = (req, res, next) => { global.currentRequest = req; next(); };` and :25-33 `if (global.currentRequest) { const detectedPath = global.currentRequest.headers[headerName...] }`. publicBaseUrl.js:72-77 `buildPublicBaseUrl(req)` takes proto/host from `req` but basePath from `getBasePath()` — i.e. from whatever request last touched the global. AsyncLocalStorage context opened in setup.js:409-419.

**Recommended fix:** Store the detected prefix in the existing AsyncLocalStorage request context (utils/requestContext.js) or pass req explicitly to getBasePath/buildPublicUrl. Delete global.currentRequest.

<sub>Verifier: Code matches claim: global.currentRequest set at basePath.js:237, read at :25-33; buildPublicBaseUrl mixes req host with global basePath (publicBaseUrl.js:72-76); ALS exists (requestContext.js). Real cross-request race + anti-pattern; /api/health:305 has an await window. But blast radius is narrow: </sub>

---

### 59. configCache auto-refresh permanently stops after the first unchanged cycle (hot reload silently dies)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:medium`

**Files:**
- `server/configCache.js:569`
- `server/configCache.js:585`
- `server/configCache.js:559`

**Problem:** The refresh timer is a one-shot setTimeout re-armed only inside setCacheEntry. refreshCacheEntry for apps/models/prompts/workflows/agents/groups/platform/credentials/skills skips setCacheEntry when the ETag is unchanged — so after the first TTL where nothing changed, the timer is never re-armed and that entry never refreshes again; edits to contents/apps/*.json are never picked up (contradicts CLAUDE.md's 'reloaded automatically'). The comparison is also wrong the other way: newEtag is computed from RAW loaded data while the stored etag was computed AFTER env-var resolution, so files with ${VAR} placeholders (default platform.json) mismatch every cycle and re-cache forever.

**Evidence:** configCache.js:569-573 `const refreshTimer = setTimeout(() => { this.refreshCacheEntry(key); }, this.cacheTTL); this.refreshTimers.set(key, refreshTimer);` — only re-arm point (refreshTimers.set appears once). refreshCacheEntry apps branch :586-596: `const newEtag = this.generateETag(apps); ... if (!existing || existing.etag !== newEtag) { this.setCacheEntry(key, apps); } return;` — no re-arm on the unchanged path. setCacheEntry:551-559 computes etag from `resolveEnvVarsInObject(data)`; server/defaults/config/platform.json contains `${NODE_ENV:-production}`, so raw-vs-resolved etags never match.

**Recommended fix:** Always re-arm the timer in refreshCacheEntry's finally block (or switch to a single setInterval per key), and compare ETags computed from the same representation (resolve env vars before hashing on both sides).

<sub>Verifier: Verified. setTimeout(569)/refreshTimers.set(573) exist only in setCacheEntry; no setInterval or file watcher in server/. Guarded branches (apps 588-595, models, prompts, workflows, agents, groups, credentials, skills) skip setCacheEntry when etag unchanged, so the fired one-shot timer is never re-ar</sub>

---

### 60. Fix no-op ternary in featureFlags.isAppFeatureEnabled — object-valued features always return the default

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `shared/featureFlags.js:78`
- `shared/featureFlags.js:141`

**Problem:** isAppFeatureEnabled's final return is `value !== false && value !== undefined && value !== null ? defaultValue : defaultValue` — both branches identical, so the documented 'non-boolean values count as enabled' behavior never happens. Any feature configured as an object (e.g. `features: { shortLinks: {...} }` or `features: { export: {...} }`) is treated as unconfigured: isBothEnabled callers (AppChat.jsx:131 shortLinks; ExportConversationMenu, ChatHeader, ChatActionsMenu, QuillToolbar, ExportMenu for export) fall back to the default regardless of the configured object. Impact is latent since only boolean flags ship today. The `createFeatureFlags` factory export also has zero callers.

**Evidence:** shared/featureFlags.js:78 `return value !== false && value !== undefined && value !== null ? defaultValue : defaultValue;` — identical branches. Callers: client/src/features/apps/pages/AppChat.jsx:131 `featureFlags.isBothEnabled(app, 'shortLinks', true)`; client/src/features/canvas/components/ExportMenu.jsx:12. `grep -rn createFeatureFlags client/src server shared` → only the definition and a README mention.

**Recommended fix:** Change the tail to `return value !== false;` (or `value?.enabled !== false` if object features carry an enabled flag), add a unit test for object-valued features, and delete the unused createFeatureFlags export.

<sub>Verifier: shared/featureFlags.js:78 is a genuine no-op ternary — both branches return defaultValue — so the documented "non-boolean counts as enabled" (comment 76-77) never runs; object-valued features always yield defaultValue. Callers verified (AppChat.jsx:131, ExportMenu.jsx:12, QuillToolbar:25, ChatAction</sub>

---

### 61. ContentInstaller path-traversal guard uses prefix match without a separator

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/services/marketplace/ContentInstaller.js:533`

**Problem:** When writing a multi-file skill package, the traversal guard is `if (!resolvedPath.startsWith(path.resolve(skillDir)))`. Because path.resolve(skillDir) has no trailing path separator, a filename resolving into a sibling directory that shares the name prefix (e.g. skillDir `/contents/skills/foo`, filename `../foo-evil/x` -> `/contents/skills/foo-evil/x`) passes the check and is written outside the intended skill directory. Current callers constrain companion filenames (findCompanionFiles filters to the dir prefix, so no leading `..`), which limits exploitability today, but the check itself is wrong and is the kind of pattern that gets copied.

**Evidence:** ContentInstaller.js:533-537: `const resolvedPath = path.resolve(filePath); if (!resolvedPath.startsWith(path.resolve(skillDir))) { throw new Error('Path traversal detected...'); }` — missing `+ path.sep`. Compare to the correct trailing-separator boundary check in utils/pathSecurity.js:173.

**Recommended fix:** Reuse resolveAndValidatePath(filename, skillDir) from utils/pathSecurity.js, or append path.sep before startsWith (and allow the exact-equal case).

<sub>Verifier: Verified ContentInstaller.js:533-535: guard is `!resolvedPath.startsWith(path.resolve(skillDir))` with no `path.sep`, vs correct `baseWithSep` check at pathSecurity.js:173. The prefix match genuinely lets a filename resolving to a prefix-sharing sibling (e.g. `/contents/skills/foo-evil/x` vs skillDi</sub>

---

### 62. Strict app/model schema drops Zod defaults when config has any unknown key

**Severity:** low · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `bug` `sev:low`

**Files:**
- `server/utils/resourceLoader.js:350`
- `server/validators/appConfigSchema.js:381`

**Problem:** createSchemaValidator applies parsed data (with Zod defaults + unknown-key stripping) only when safeParse succeeds; on failure it returns the ORIGINAL unparsed item. Because appConfigSchema and modelConfigSchema use .strict(), any config containing a single stray/legacy key makes safeParse fail — so the schema-provided defaults (e.g. enabled, sendChatHistory, preferredOutputFormat) are silently NOT applied and the raw object is used, while only a warning is logged. Configs that 'mostly work' can thus behave differently from what the schema documents.

**Evidence:** resourceLoader.js:358-373 `const result = schema.safeParse(item); if (!result.success) { logger.warn(...) } else { validatedItem = result.data; }` — failure path keeps `item`. appConfigSchema.js:381 `.strict()`; modelConfigSchema.js:169 `.strict()`. A separate knownKeys warning (resourceLoader.js:377) confirms unknown keys are expected in the wild.

**Recommended fix:** On parse failure, fall back to parsing against a non-strict variant (or `.passthrough()`) so defaults still apply, or surface the validation error instead of silently using the raw object. Decide explicitly whether strict should reject-load or lenient-load.

<sub>Verifier: Code matches claim: resourceLoader.js:355/389 returns raw item on safeParse failure; only success (line 372) applies Zod defaults. appConfigSchema.js:381 and modelConfigSchema.js:169 use .strict(), so any unknown key fails validation, dropping defaults like enabled/sendChatHistory (defaults true). W</sub>

---

### 63. Tool-argument 'repair' replace(/}{/g, ',') corrupts valid JSON arguments before first parse

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/services/chat/ToolExecutor.js:366`

**Problem:** executeToolCall mutates the raw tool-call arguments with `toolCall.function.arguments.replace(/}{/g, ',')` BEFORE attempting the first JSON.parse. This is meant to patch concatenated streaming fragments (`{...}{...}`), but it runs unconditionally, so perfectly valid JSON whose string values contain `}{` (e.g. a code snippet, regex, or text argument) is corrupted — `{"text":"}{"}` becomes `{"text":","}` (silently wrong args) or unparseable input that degrades to `args = {}`, making the tool run with empty arguments and no error surfaced to the model.

**Evidence:** ToolExecutor.js:366-368: `let finalArgs = toolCall.function.arguments.replace(/}{/g, ',');` followed by `args = JSON.parse(finalArgs);` — the untouched original string is never tried first.

**Recommended fix:** Try JSON.parse on the raw string first; only apply the `}{` merge heuristic as a fallback after a parse failure. Better: fix fragment merging where the chunks are accumulated (the 'smart concatenation' block) instead of post-hoc string surgery.

<sub>Verifier: ToolExecutor.js:366 does `finalArgs = toolCall.function.arguments.replace(/}{/g,',')` then parses at :368 — the raw string is never parsed first, and the fallbacks (:370-373) operate on the already-mutated string. Concretely, valid `{"text":"}{"}` (value=`}{`) → `{"text":","}`, a silently wrong arg.</sub>

---

### 64. Anthropic requests send literal `Authorization: undefined` header instead of removing it

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/adapters/anthropic.js:216`

**Problem:** The Anthropic adapter tries to strip the Bearer Authorization header set by createRequestHeaders by assigning `Authorization: undefined` in the spread. Object spread keeps the key, and Node's fetch/Headers stringifies the value, so every Anthropic request carries the header `authorization: undefined` (verified with undici Headers). Anthropic currently authenticates via x-api-key and ignores it, but any intermediary proxy or future API strictness that inspects Authorization will reject or misroute these requests, and the code's stated intent ('Remove Authorization header') simply doesn't happen.

**Evidence:** anthropic.js:213-218 `headers: { ...this.createRequestHeaders(apiKey), 'x-api-key': apiKey || '', Authorization: undefined, // Remove Authorization header for Anthropic ... }`. Verified: `new Headers({Authorization: undefined})` yields `[ 'authorization', 'undefined' ]` in this repo's Node runtime.

**Recommended fix:** Build Anthropic headers explicitly (Content-Type, x-api-key, anthropic-version) instead of spreading createRequestHeaders and 'deleting' via undefined; or add an options flag to createRequestHeaders to skip Authorization.

<sub>Verifier: anthropic.js:216 sets `Authorization: undefined` in an object spread ("Remove Authorization header"), but spread keeps the key. request.headers flows unchanged to node-fetch@3 via StreamingHandler.js:348/NonStreamingHandler.js:50 → httpFetch (httpConfig.js:469). Finding cited undici, but repo uses n</sub>

---

### 65. Wrong destructuring makes /api/apps/:appId ignore configured defaultLanguage

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/routes/generalRoutes.js:330`

**Problem:** configCache.getPlatform() returns the platform object directly (configCache.js:1060 `return this.get('config/platform.json').data`). The handler destructures it as `const { data: platform } = configCache.getPlatform() || {}`, reading a nonexistent `.data` property, so `platform` is always undefined and `defaultLang` always falls back to 'en'. When a client sends no Accept-Language header, localized 'appNotFound' errors are always English instead of the platform's configured defaultLanguage. Other files (modelRoutes.js:126, chat/sessionRoutes.js:656) read it correctly.

**Evidence:** generalRoutes.js:330 `const { data: platform } = configCache.getPlatform() || {};` then line 331 `const defaultLang = platform?.defaultLanguage || 'en';`. configCache.js:1059-1061 getPlatform returns `.data` (the object itself).

**Recommended fix:** Change to `const platform = configCache.getPlatform() || {};` to match the actual return shape.

<sub>Verifier: getPlatform() returns the platform object itself (configCache.js:1060). generalRoutes.js:330 destructures `{ data: platform }`, reading a nonexistent `.data` key (platform.json has no top-level `data`; defaultLanguage is top-level), so platform is undefined and defaultLang always = 'en'. modelRoutes</sub>

---

### 66. apps DELETE ignores findAppFile — apps whose filename differs from their ID cannot be deleted

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/routes/admin/apps.js:1048`
- `server/routes/admin/apps.js:616`

**Problem:** PUT and toggle deliberately resolve the real file via findAppFile because 'the filename doesn't match the app ID' is a supported case (apps.js:23-27, 615, 832). DELETE skips that helper and probes `contents/apps/${appId}.json` directly with readFileSync, so any app stored under a different filename returns 404 'App not found' on delete while it remains fully editable/toggleable — an inconsistency users hit as an undeletable app. The POST duplicate check has the mirror-image gap: it only checks `${id}.json` existence, so a second app with the same ID under a different filename can be created.

**Evidence:** apps.js:1048 `const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`); try { readFileSync(appFilePath, 'utf8'); } catch { return sendNotFound(res, 'App'); }` vs apps.js:616 `const filename = await findAppFile(appId, appsDir);` in PUT.

**Recommended fix:** Use findAppFile in DELETE (and check configCache for ID collisions in POST) — or drop filename≠id support everywhere and enforce filename==id with a migration.

<sub>Verifier: Verified in server/routes/admin/apps.js: DELETE (line 1048) probes contents/apps/${appId}.json via readFileSync, unlike PUT (616), toggle (833), batch toggle (955) which all use findAppFile to handle filename≠id (helper at 29-51, comment 22-27). resourceLoader.js:62-97 keys apps by the .id field, no</sub>

---

### 67. server/cli/update.js: catch parameter shadows error() helper, crashing every updater failure path

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/cli/update.js:231`
- `server/cli/update.js:44`

**Problem:** runUpdateCLI wraps all subcommands in `try { ... } catch (error) { error(error.message); }`. The catch binding `error` shadows the `error(msg)` logging function defined at line 44, so the caught Error object is invoked as a function. Any real failure in the self-update CLI (network error contacting GitHub, checksum mismatch, download failure) therefore dies with 'TypeError: error is not a function' instead of the intended readable message — exactly when an operator most needs diagnostics. The process still exits 1, but the actual cause is swallowed.

**Evidence:** server/cli/update.js:44 `function error(msg) { console.error(...) }`; :231-234 `} catch (error) {\n    error(error.message);\n    process.exit(1);\n  }` — the catch-scoped Error shadows the function.

**Recommended fix:** Rename the catch binding: `catch (err) { error(err.message); process.exit(1); }`. Add a smoke test that exercises a failing update check.

<sub>Verifier: Verified in server/cli/update.js: error() helper at :44; catch block :231-234 does `catch (error) { error(error.message); process.exit(1); }`. The catch binding shadows the helper, so error(error.message) calls the Error object as a function → TypeError, aborting before process.exit(1). Reachable vi</sub>

---

### 68. Numeric app-form inputs store NaN when cleared, and the output-format select is missing 'html' from the server schema

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `client/src/features/admin/components/AppFormEditor.jsx:522`
- `client/src/features/admin/components/AppFormEditor.jsx:537`
- `server/validators/appConfigSchema.js:329`

**Problem:** Clearing the Temperature field stores `parseFloat('') === NaN` into app.preferredTemperature (line 522) while the input displays the `|| 0.7` fallback — the form looks fine but the state holds NaN, which JSON-serializes to null and is rejected by the strict server schema with a message the UI then garbles (see error-handling finding). Same unguarded parseInt for imageUpload/fileUpload/audioUpload maxFileSizeMB (1714, 1816, 1898) and inputMode rows (2223). Separately, the Output Format select offers only markdown/text/json while the server schema allows 'html' — an html-configured app silently displays as 'markdown' and gets rewritten on save.

**Evidence:** Line 520-523: `value={app.preferredTemperature || 0.7}` + `parseFloat(e.target.value)` with no NaN guard. Lines 537-539 have three <option> values; server enum appConfigSchema.js:329 `z.enum(['markdown','text','json','html'])` has four.

**Recommended fix:** Guard numeric handlers (`const n = parseFloat(v); handleInputChange(field, Number.isFinite(n) ? n : undefined)`) and add the missing html option. Longer term, derive select options from the fetched JSON schema enum to prevent drift.

<sub>Verifier: Both code claims verified. AppFormEditor.jsx:520-522 uses unguarded parseFloat (NaN on clear, display shows ||0.7); same at 1714/1816/1898/2223; line 383 shows the ||0 guard exists elsewhere. Select at 537-539 has 3 options vs 4-value enum at appConfigSchema.js:329 (includes 'html'). But consequence</sub>

---

### 69. Undefined CACHE_KEYS members produce 'undefined?...' cache keys and silently disable caching

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `client/src/api/endpoints/misc.js:26`
- `client/src/api/endpoints/misc.js:40`
- `client/src/api/endpoints/misc.js:71`
- `client/src/api/endpoints/models.js:34`
- `client/src/utils/cache.js:214`

**Problem:** CACHE_KEYS in utils/cache.js defines 9 keys, but endpoint modules reference four members that don't exist: CACHE_KEYS.TRANSLATIONS, CACHE_KEYS.PAGE_CONTENT, CACHE_KEYS.TOOLS, CACHE_KEYS.MODEL_DETAILS. buildCacheKey(undefined, {…}) yields keys like 'undefined?id=faq&language=en' (works by accident), while fetchToolsBasic passes bare `CACHE_KEYS.TOOLS` (undefined) as the cacheKey — falsy, so tool lists are never cached or deduplicated despite the explicit MEDIUM TTL argument. The 'consistency' registry the constants were built for is silently broken.

**Evidence:** cache.js:214-224 CACHE_KEYS = { APPS_LIST, APP_DETAILS, MODELS_LIST, STYLES, PROMPTS, UI_CONFIG, PLATFORM_CONFIG, AUTH_STATUS, MIMETYPES_CONFIG } — no TRANSLATIONS/PAGE_CONTENT/TOOLS/MODEL_DETAILS. misc.js:26 `buildCacheKey(CACHE_KEYS.TRANSLATIONS, { language })`; misc.js:40 `buildCacheKey(CACHE_KEYS.PAGE_CONTENT, {...})`; misc.js:71 `const cacheKey = skipCache ? null : CACHE_KEYS.TOOLS;` then `handleApiResponse(..., cacheKey, DEFAULT_CACHE_TTL.MEDIUM)`; models.js:34 `buildCacheKey(CACHE_KEYS.MODEL_DETAILS, { id: modelId })`.

**Recommended fix:** Add the four missing constants to CACHE_KEYS (fixing fetchToolsBasic's lost caching), or drop the registry and use literal strings consistently as endpoints/skills.js already does.

<sub>Verifier: All cited code verified. cache.js:214-224 has 9 keys, none named TRANSLATIONS/PAGE_CONTENT/TOOLS/MODEL_DETAILS, and CACHE_KEYS is never augmented (grep). misc.js:71 passes bare undefined CACHE_KEYS.TOOLS; requestHandler.js guards cache/dedup/store on `if(cacheKey)` (lines 19,30,59), so tools are gen</sub>

---

### 70. POST /api/auth/users writes `groups` but login reads `internalGroups`, silently discarding assigned groups

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/middleware/localAuth.js:179`
- `server/middleware/localAuth.js:120`
- `server/routes/auth.js:600`

**Problem:** createUser() (used by the admin-only POST /api/auth/users) stores the assigned groups under a `groups` key and defaults to ['user']. loginUser() reads `user.internalGroups || ['user']` — it never looks at `groups`. So any groups assigned when creating a user through this endpoint are ignored at login; the user always falls back to ['user'] (a group that does not even exist in groups.json). The parallel admin path in routes/admin/auth.js correctly uses `internalGroups`, so there are two divergent user-creation code paths with different field contracts.

**Evidence:** localAuth.js:184 newUser includes `groups` (from `groups = ['user']` default at :156), no internalGroups. localAuth.js:120 `groups: user.internalGroups || ['user']`. routes/admin/auth.js:406 uses `internalGroups`. The nonexistent group 'user' vs actual 'users' in server/defaults/config/groups.json compounds the issue.

**Recommended fix:** Make createUser write `internalGroups` (and default to 'users' not 'user'), or consolidate onto the admin/auth.js creation path and remove the duplicate.

<sub>Verifier: Verified: createUser (localAuth.js:156,184) writes `groups`, no `internalGroups`; loginUser (localAuth.js:120) reads `user.internalGroups||['user']`, so created-user groups are discarded and default to `['user']`, which is absent from groups.json (only `users` exists). admin/auth.js:406 correctly us</sub>

---

### 71. createSourceManager singleton silently ignores per-call config

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/sources/index.js:20`
- `server/services/PromptService.js:297`
- `server/services/workflow/executors/PromptNodeExecutor.js:1369`

**Problem:** createSourceManager caches a single SourceManager in module scope and returns it on every subsequent call, discarding the `config` argument. Two callers pass `{ filesystem: { basePath: path.resolve(getRootDir(), config.CONTENTS_DIR) } }` expecting the filesystem handler to be configured — but whichever call runs first (e.g. SourceResolutionService constructor or toolLoader with no args) wins, and the basePath override is dropped. It works today only because FileSystemHandler's default basePath happens to equal what they pass; if CONTENTS_DIR handling or defaults ever diverge, sources silently resolve against the wrong root.

**Evidence:** index.js:21-24 `if (!singletonSourceManager) { singletonSourceManager = new SourceManager(config); } return singletonSourceManager;` — config used only on first construction. PromptService.js:297 and PromptNodeExecutor.js:1369 both pass a filesystem.basePath config that is a no-op after the first instantiation.

**Recommended fix:** Either drop the config args at those call sites (rely on the handler default and document it), or make SourceManager reconfigure the filesystem handler basePath per call, or key the singleton cache by config. Remove the misleading dead config.

<sub>Verifier: Verified: sources/index.js:21-24 uses `config` only on first construction and returns the cached singleton thereafter. SourceResolutionService.js:19 and toolLoader.js:357 call it with no args before PromptService.js:297/PromptNodeExecutor.js:1369 ever run, so those basePath overrides are always drop</sub>

---

### 72. cleanupEvents read-filter-rewrite races with concurrent flush appends, silently losing usage events

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/services/UsageEventLog.js:126`

**Problem:** cleanupEvents (called hourly from UsageAggregator.runRollups) reads the whole usage-events.jsonl, filters by retention, and rewrites the file with fs.writeFile — with no synchronization against the 10-second flush timer that appends new events to the same file. An append landing between the read and the rewrite is overwritten and lost. feedbackStorage.js documents and fixes this exact race for feedback.jsonl with an in-process write lock, but the fix was never ported to UsageEventLog. (Cross-worker appends under WORKERS>1 widen the window — see the clustering finding.)

**Evidence:** UsageEventLog.js:126-145: `const events = await readEvents(); ... await fs.writeFile(eventFile, lines, 'utf8');` with no lock, while scheduleFlush/periodic interval (25-35, 148-154) call flushQueue → fs.appendFile on the same eventFile. Contrast feedbackStorage.js:17-29 `withWriteLock` and its comment, plus cleanupFeedback:133-141 draining the queue under the lock before rewriting. Trigger: UsageAggregator.js:331-337 runRollups → cleanupEvents.

**Recommended fix:** Port feedbackStorage's withWriteLock pattern to UsageEventLog: serialize flushQueue and cleanupEvents on one lock, and drain the queue inside the lock before the rewrite. (Or fold both into the shared persistence utility proposed separately.)

<sub>Verifier: Code matches claim. UsageEventLog.js:129/133/136 does read-filter-writeFile with no lock; flushQueue (line 21) appendFiles the same file, fired by setInterval (148-154). cleanupEvents runs hourly with default eventRetentionDays=90 (server.js:352-355 → runRollups → 336). feedbackStorage.js:21-29,133-</sub>

---

### 73. Duplicate SSE error events and no terminal 'done' event on tool-loop failures

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `server/services/chat/ToolExecutor.js:1523`
- `server/services/chat/ToolExecutor.js:1204`

**Problem:** When an LLM call inside continueWithToolExecution fails (e.g. provider 429/500 on a follow-up round), its catch block calls actionTracker.trackError and re-throws; the caller processChatWithTools' catch then computes the same localized message and calls trackError again. The client receives two error events for one failure. Additionally, unlike StreamingHandler which guarantees a terminal done event in its finally block (`if (!doneEmitted) actionTracker.trackDone(...)`), neither ToolExecutor catch emits trackDone, so the tool path ends the request with no done event at all after an error.

**Evidence:** ToolExecutor.js:1523 `actionTracker.trackError(chatId, { ...errMsg });` followed by 1529 `throw error; // Re-throw to let the calling method handle it`, and processChatWithTools' catch at 1184-1204 repeating `actionTracker.trackError(chatId, { ...errMsg })` for the same error object. StreamingHandler.js:575-578 shows the finally-based done guard.

**Recommended fix:** Either stop re-throwing after tracking, or track only at the top level. Add a finally-based `trackDone` guard mirroring StreamingHandler so the stream always terminates cleanly.

<sub>Verifier: Code facts verified: continueWithToolExecution catch (ToolExecutor.js:1523) calls trackError then re-throws (1529); processChatWithTools' single try(878)/catch(1184) calls trackError again (1204) for the same error—real double-emit. No trackDone in either tool-path catch, unlike StreamingHandler.js:</sub>

---

### 74. AdminAgentEditPage.handleSave mutates React state and the shared BLANK_PROFILE constant via shallow copy + nested delete

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `bug` `sev:low`

**Files:**
- `client/src/features/admin/pages/AdminAgentEditPage.jsx:234`
- `client/src/features/admin/pages/AdminAgentEditPage.jsx:145`

**Problem:** handleSave does `const payload = { ...profile }` (shallow) then mutates nested objects in place: `delete payload.planner.system`, `delete payload.memory.prompt`, `payload.synthesizer.system = ...`. Those nested objects are the same references held in React state — and for a new agent they are the module-level BLANK_PROFILE constant, so saving a new agent permanently strips planner/synthesizer/memory sub-fields from BLANK_PROFILE for the rest of the session. Loaded profiles also set profile and initialData to the SAME object, so the in-place cleaning makes useUnsavedChanges report 'not dirty' — after a FAILED save the user can navigate away and lose edits.

**Evidence:** Line 234 `const payload = { ...profile };` then line 254 `else delete payload.planner.system;`, line 279 `else delete payload.memory.system;`. Line 112 `useState(BLANK_PROFILE)`. Lines 145-147 `setProfile(mergedProfile); setInitialData(mergedProfile)` share one object. useUnsavedChanges.js:34 computes dirty via deepEqual(initialData, currentData).

**Recommended fix:** Build the payload with structuredClone(profile) before cleaning, and set initialData to a separate clone on load. Ideally move the cleanLocalized/strip logic into a pure buildAgentPayload(profile) helper with a unit test.

<sub>Verifier: Mechanism verified: line 234 shallow-spreads, lines 251-299 mutate shared nested refs, line 112 shares BLANK_PROFILE, lines 145-147 alias profile/initialData. But impact is overstated. useUnsavedChanges.js:34 uses deepEqual: shared refs short-circuit a===b, and cleaning only deletes empty keys or re</sub>

---

## ♻️ Duplication

### 75. Deduplicate ToolExecutor's two ~250-line streaming loops; the continuation loop silently drops thinking, images, and grounding

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:high`

**Files:**
- `server/services/chat/ToolExecutor.js:913`
- `server/services/chat/ToolExecutor.js:1314`

**Problem:** processChatWithTools (~901-1105) and continueWithToolExecution (~1314-1497) contain a near-identical SSE-parse/collect-tool-calls loop that has diverged: (1) the first loop forwards thinking/images/grounding to the client (942-948), the continuation loop does not — so for tool-enabled apps, thinking content and generated images in responses after a tool ran are silently discarded; (2) the first loop filters empty-name tool calls (1046) and does smart argument concatenation (969-979), the continuation does neither; (3) only the continuation collects message-level thoughtSignatures; (4) passthrough tools: first loop keeps iterating after trackDone (can emit multiple done events), continuation returns immediately.

**Evidence:** grep shows processImages/processThinking/processGroundingMetadata called only at ToolExecutor.js:942-948 (first loop); the continuation loop (1324-1391) handles only content/tool_calls/thoughtSignatures/finishReason. Empty-name filter `validToolCalls = collectedToolCalls.filter(...)` exists only at 1045-1048.

**Recommended fix:** Extract a single `readLLMStreamTurn()` helper (parse events, accumulate content/tool calls/thinking/images/thoughtSignatures, filter invalid calls) used by both entry points, or make processChatWithTools delegate its first turn to the same loop as continueWithToolExecution.

<sub>Verifier: All claims verified. First loop forwards images/thinking/grounding (ToolExecutor.js:942-948; StreamingHandler.js:49-86 confirms these emit client SSE events); continuation loop (1324-1391) handles only content/tool_calls/thoughtSignatures — dropping them silently after any tool call. Empty-name filt</sub>

---

### 76. build-client-binaries.yml is a ~170-line copy of build-binaries.yml, both on archived actions-rs and a stale uuid hack

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `.github/workflows/build-client-binaries.yml:37`
- `.github/workflows/build-binaries.yml:104`
- `.github/workflows/build-binaries.yml:76`
- `client/package.json:52`

**Problem:** The full SEA build job (Node setup, mdBook, Rust toolchain, cargo cache, mdbook-mermaid, deps, version sync, SEA build, Windows .bat, archive, base64 encode, upload) exists nearly verbatim in build-binaries.yml (twice: build-check and build jobs) and again in build-client-binaries.yml, and the mdBook/Rust block appears a fourth time in mdbook.yml. All copies use `actions-rs/toolchain@v1`, archived/unmaintained since 2023 and emitting deprecation warnings. build-binaries.yml also still runs `npm ci && npm install uuid` even though uuid is a declared client dependency, mutating the lockfile mid-CI.

**Evidence:** Diff of build-client-binaries.yml:37-199 vs build-binaries.yml:125-294: step-for-step identical (checkout, mdbook, actions-rs/toolchain@v1 at lines 53/141, cargo cache, base64 encoding block). build-binaries.yml:76-81 `cd client\n npm install\n npm install uuid` labeled 'Install client dependencies with uuid package' vs client/package.json:52 '"uuid": "^14.0.1"'.

**Recommended fix:** Extract a composite action (.github/actions/build-sea) or a reusable workflow with the shared steps and call it from both workflows; replace actions-rs/toolchain with dtolnay/rust-toolchain; delete the `npm install uuid` step.

<sub>Verifier: All claims verified. build-client-binaries.yml:37-199 is step-for-step identical to build-binaries.yml:125-294 (~160 lines: same steps, identical cargo cache key, base64 block). actions-rs/toolchain@v1 (archived 2023) appears 4×: build-binaries.yml:43,141; build-client-binaries.yml:53; mdbook.yml:33</sub>

---

### 77. Remove one of the two complete login UI implementations

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/auth-gate/auth-gate.js:1`
- `client/src/features/auth/components/LoginForm.jsx:1`
- `client/src/pages/LoginPage.jsx:60`
- `client/vite-plugins/vite-plugin-auth-gate.js:1`

**Problem:** Two full login UIs are maintained in parallel: the vanilla-JS pre-React 'auth gate' (auth-gate.js 999 lines + auth-gate.css 429 + i18n.js 92 + a custom 199-line Vite plugin to inline it) and the React LoginForm.jsx (473 lines) — both implement local+LDAP+OIDC provider selection and share a localStorage remember-me key. LoginPage.jsx treats the React form as a fallback for a state its own comment calls impossible: 'Fall back to the in-page form only if the gate is somehow unavailable (it is inlined on every index.html entry).' LoginForm's only other consumer is SetupWizard's embedded mode. Every auth-flow change must be made twice.

**Evidence:** LoginPage.jsx:60-69 comment and `if (window.__authGate) return <spinner/>` before ever rendering LoginForm; auth-gate.js:26-29 'REMEMBERED_USERNAME_KEY ... Shared with the React LoginForm so the preference carries across both surfaces'; wc -l: auth-gate.js 999, LoginForm.jsx 473, vite-plugin-auth-gate.js 199. Only imports of LoginForm: LoginPage.jsx:4 and SetupWizard.jsx:7.

**Recommended fix:** Make the auth gate the single login UI: use it (overlay mode already exists) for SetupWizard's login step, then delete LoginForm.jsx and the LoginPage fallback branch. Alternatively invert and delete the gate — but keep exactly one.

<sub>Verifier: Verified: auth-gate.js (999L) and LoginForm.jsx (473L) both implement local+LDAP+OIDC+NTLM with identical isLocalPrimary ordering (auth-gate.js:481 vs LoginForm.jsx:145) and selectedAuthMethod state, sharing key 'ihub_rememberedUsername' (auth-gate.js:29 comment + LoginForm.jsx:9). LoginPage.jsx:63 </sub>

---

### 78. Introduce a shared Modal component; 39 files hand-roll the same overlay/dialog shell

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/features/prompts/components/PromptDetailsPopup.jsx:30`
- `client/src/features/apps/components/AppDetailsPopup.jsx:18`
- `client/src/shared/components/ModelDetailsPopup.jsx`

**Problem:** There is no shared Modal primitive (shared/components has only the specialized ConfirmDialog/SearchModal), so 39 client files hand-roll `fixed inset-0` overlay dialogs; 7 share a byte-identical overlay class string. The three details popups (App/Prompt/Model) are structural clones — same header with icon tile, title, id, close button, same scroll body — and have already diverged: PromptDetailsPopup registers an Escape-key close handler (12-21) while AppDetailsPopup has none, so keyboard dismissal is inconsistent. None implement focus trapping or aria-modal, so every accessibility fix must be made 39 times.

**Evidence:** grep -l 'fixed inset-0' client/src --include=*.jsx -> 39 files; exact string 'fixed inset-0 bg-gray-600 bg-opacity-50' -> 7 files. PromptDetailsPopup.jsx:12-21 `useEffect(... if (e.key === 'Escape') onClose() ...)` vs AppDetailsPopup.jsx:1-16 which goes straight from props to render with no key handler. Header markup at PromptDetailsPopup.jsx:33-55 and AppDetailsPopup.jsx:21-44 is the same shell modulo icon/color.

**Recommended fix:** Create shared/components/Modal.jsx (overlay, Escape handling, focus trap, aria-modal, size variants) and a DetailsPopup composition for the three popup clones. Migrate the 7 exact-string copies first, then adopt incrementally.

<sub>Verifier: All claims verified. grep confirms 39 files with `fixed inset-0` and exactly 7 with `fixed inset-0 bg-gray-600 bg-opacity-50`. No generic Modal in shared/components (only ConfirmDialog/SearchModal + specialized popups). PromptDetailsPopup.jsx:12-21 has an Escape handler; AppDetailsPopup.jsx (line 11</sub>

---

### 79. Deduplicate platform.json section-update handlers (identical savePlatformConfig copied across admin routes)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/routes/admin/browserExtension.js:36`
- `server/routes/admin/nextcloudEmbed.js:13`
- `server/routes/admin/cors.js:135`
- `server/routes/admin/ssrf.js:111`
- `server/routes/admin/ssl.js:121`
- `server/routes/admin/usage.js:162`

**Problem:** Eight admin route files each reimplement 'update one section of platform.json': read config, mutate section, atomicWriteJSON, refreshCacheEntry('config/platform.json'). browserExtension.js:36-44 and nextcloudEmbed.js:13-24 contain a literally identical `savePlatformConfig(updates)` function (nextcloud's copy gained an explanatory comment the other lacks — proof of drift). Worse, the copies disagree on the read source: browserExtension/nextcloudEmbed spread configCache.getPlatform() (in-memory) while cors.js, ssrf.js, usage.js re-read and re-parse the file from disk. Two concurrent saves of different sections can clobber each other, and any change to platform persistence must be replicated in 8 places.

**Evidence:** browserExtension.js:36-44 and nextcloudEmbed.js:13-24: same body `const existing = configCache.getPlatform() || {}; const merged = { ...existing, ...updates }; await atomicWriteJSON(platformConfigPath, merged); await configCache.refreshCacheEntry('config/platform.json');`. Disk-read variant: cors.js:135-141 `const platformContent = await fs.readFile(platformPath,'utf8'); ...`; same shape at ssrf.js:111-117, ssl.js:113-121, usage.js:162-170, logging.js:107/212, auditLog.js:215.

**Recommended fix:** Add `updatePlatformSection(sectionKey, updater)` in server/utils (or configCache) that serializes writes (single promise queue), always reads from one canonical source, writes atomically, and refreshes the cache. Replace all eight in-route copies, deleting both savePlatformConfig clones.

<sub>Verifier: All cites verified. browserExtension.js:36-44 and nextcloudEmbed.js:12-23 hold byte-identical savePlatformConfig bodies differing only by nextcloud's comment (15-17), both reading configCache.getPlatform(). cors.js:135, ssrf.js:111, ssl.js:111, usage.js:162, logging.js:97, auditLog.js:207 each re-re</sub>

---

### 80. Delete dead ImageUploader and deduplicate the image resize/TIFF pipeline (three copies)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/features/upload/components/ImageUploader.jsx:28`
- `client/src/features/upload/components/UnifiedUploader.jsx:153`
- `client/src/features/office/utilities/buildChatApiMessages.js:13`

**Problem:** UnifiedUploader.jsx's processImage (153-299) is a near-verbatim ~150-line copy of ImageUploader.jsx's processImage (28-173): identical TIFF multipage handling, blob-preview creation, canvas resize to 1024px, and JPEG re-encode at 0.8 quality. ImageUploader itself is dead — its only reference is the barrel export in upload/components/index.js; ChatInput and StartWorkflowModal use UnifiedUploader. A third copy of the resize/re-encode logic lives in the Office add-in (buildChatApiMessages.js, commented 'Match ImageUploader: cap at 1024px and re-encode as JPEG at 80% quality'), which will drift the moment the main pipeline changes.

**Evidence:** Compare ImageUploader.jsx:136-152 and UnifiedUploader.jsx:260-276: identical canvas block ending `const base64 = canvas.toDataURL('image/jpeg', 0.8);`. Repo-wide grep for 'ImageUploader' finds only components/index.js:3 (`export { default as ImageUploader }`), a prop name in CanvasChatPanel.jsx, and the comment in buildChatApiMessages.js:8. buildChatApiMessages.js:13/85-86: `const IMAGE_MAX_DIMENSION = 1024; ... canvas.toDataURL('image/jpeg', IMAGE_REENCODE_QUALITY)`.

**Recommended fix:** Move processImage (incl. TIFF handling) into features/upload/utils/fileProcessing.js as the single implementation; have UnifiedUploader and the Office buildChatApiMessages call it. Delete ImageUploader.jsx and its barrel export.

<sub>Verifier: Verified all claims. ImageUploader.jsx:136-152 and UnifiedUploader.jsx:260-276 canvas blocks are byte-identical (both end `toDataURL('image/jpeg', 0.8)`); TIFF/FileReader logic near-verbatim. Grep for `<ImageUploader` = 0 hits; no destructured import exists — only barrel export index.js:3, so it is </sub>

---

### 81. Consolidate the build pipeline: three divergent copies, one broken (build.sh) and still recommended by AGENTS.md

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `build.sh:47`
- `package.json:31`
- `package.json:40`
- `docker/Dockerfile:21`
- `AGENTS.md:100`
- `dev.sh:25`

**Problem:** The production build exists in three drifted copies: (1) the npm `build` chain (package.json:31); (2) `build:docker` (package.json:40), character-for-character identical to `prod:build` — pure duplication edited in two places; (3) build.sh, which reimplements the pipeline in bash but copies only server/*.js, server/*.cjs and server/adapters — omitting routes, services, middleware, utils, validators, migrations, defaults — so its dist cannot start, yet AGENTS.md:100 still recommends `./build.sh --binary` (CI correctly uses prod:build). dev.sh duplicates `npm run dev`. The Dockerfile says 'skip docs for Docker' while build:docker runs docs:build:all, forcing a full Rust toolchain + mdbook compile into every dependency-layer rebuild.

**Evidence:** build.sh:47-49 `cp -r server/*.js dist/server/ ... cp -r server/adapters dist/server/` vs package.json:35 build:server `cp -r server/* dist/server/`; package.json:40 build:docker repeats the entire build chain inline; Dockerfile:21 `RUN curl ... sh.rustup.rs | sh` + :25 `RUN cargo install mdbook mdbook-mermaid` vs :46 comment 'skip docs for Docker'; AGENTS.md:100 'A standalone binary can be created with `./build.sh --binary`'.

**Recommended fix:** Delete build.sh and dev.sh (or reduce them to thin wrappers over npm scripts), replace build:docker with prod:build, and either actually skip docs in Docker (dropping the Rust layers) or install prebuilt mdbook binaries.

<sub>Verifier: build.sh:47-49 copies only server/*.js+adapters; server.js:14 imports ./routes/chat/index.js (plus services/middleware/utils/validators/migrations/defaults dirs all exist, uncopied) → dist cannot start. AGENTS.md:100 recommends the broken ./build.sh --binary; CI (build-binaries.yml:92) uses prod:bui</sub>

---

### 82. URL query-param application effect duplicated verbatim between AppChat and AppCanvas

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/features/apps/pages/AppChat.jsx:190`
- `client/src/features/canvas/pages/AppCanvas.jsx:60`

**Problem:** Both pages contain an almost byte-identical effect that reads model/style/outfmt/temp/history and var_* params, applies them via the same setters, then strips them from the URL. Any fix (e.g. parseFloat validation of temp, handling of new params) must be made in two places and has already drifted (AppChat also strips 'prefill'/'send').

**Evidence:** AppChat.jsx:190-257 and AppCanvas.jsx:60-121 share identical structure: `const m = searchParams.get('model'); if (m) { setSelectedModel(m); changed = true; } ...` down to the newSearch.delete([...]) cleanup.

**Recommended fix:** Extract a useUrlParamSettings(app, modelsLoading, setters) hook (or a helper) used by both pages.

<sub>Verifier: AppChat.jsx:190-257 and AppCanvas.jsx:60-121 are byte-identical in structure (same model/style/outfmt/temp/history/var_* reads, same setters, same newSearch.delete cleanup, same dep arrays). Grep confirms no shared helper — each inlines its own copy. Drift is real: AppChat.jsx:241-242 strips 'prefil</sub>

---

### 83. Extract shared edit-page scaffold — 15 AdminXxxEditPage files duplicate load/save/unsaved-changes/breadcrumb wiring

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AdminAppEditPage.jsx:15`
- `client/src/features/admin/pages/AdminModelEditPage.jsx`
- `client/src/features/admin/pages/AdminGroupEditPage.jsx:14`
- `client/src/features/admin/pages/AdminUserEditPage.jsx`
- `client/src/features/admin/pages/AdminPromptEditPage.jsx`

**Problem:** 15 pages repeat the same scaffold: `const {blocker, markSaved} = useUnsavedChanges(initialData, data)` + ConfirmDialog('Unsaved Changes'), `id === 'new'` default-object branch vs loadX(), handleSave with method/url ternary + makeAdminApiCall + markSaved + navigate, loading spinner, AdminBreadcrumb, DualModeEditor (7 pages) and Save/Cancel button row. 27 separate handleSave implementations exist. Behavior already drifts: AdminModelEditPage navigates after a 1.5s setTimeout while AdminAppEditPage navigates immediately; error handling differs per page; AdminAgentEditPage skipped DualModeEditor entirely and reimplemented a broken JSON mode.

**Evidence:** grep: 15 pages import useUnsavedChanges; 7 render DualModeEditor; 27 handleSave definitions in features/admin/pages. AdminGroupEditPage.jsx:93-121 and AdminAppEditPage.jsx:302-338 are near-identical modulo resource name. AdminModelEditPage.jsx:264-267 `setTimeout(() => navigate('/admin/models'), 1500)`.

**Recommended fix:** Build a useAdminResourceEditor({resource, schemaType, makeDefault}) hook returning {data, setData, save, blocker, loading, error} plus an AdminEditPageShell component (breadcrumb, header actions, save bar, unsaved-changes dialog). Migrate pages incrementally, starting with the DualModeEditor-based ones.

<sub>Verifier: Verified: 15 files import useUnsavedChanges and carry a byte-identical ConfirmDialog "Unsaved Changes" block. AdminGroupEditPage.jsx and AdminUserEditPage.jsx are near-identical scaffolds; handleSave cores at AdminGroupEditPage.jsx:103-116 and AdminAppEditPage.jsx:320-332 match (method/url ternary +</sub>

---

### 84. Three divergent SSRF guard implementations with differing coverage

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/services/workflow/executors/ssrfGuard.js:30`
- `server/services/mcp/safeFetch.js:51`
- `server/tools/webContentExtractor.js:13`

**Problem:** Three independent private-IP/SSRF checks with inconsistent strength. ssrfGuard.js parses IPs to bytes and correctly blocks CGNAT (100.64/10), multicast/reserved (224/4, 240/4), and IPv4-mapped IPv6 hex forms like ::ffff:a9fe:a9fe (=169.254.169.254). safeFetch.js uses a regex list that misses 100.64/10, multicast, and the hex IPv4-mapped form (it only matches dotted ::ffff:127. etc.), so an AAAA record in hex-compressed mapped form can slip past its classifier before it pins the socket. webContentExtractor.js has a third, weakest copy (no CGNAT, no multicast, no pinning, no redirect check). safeFetch backs MCP connections and the OpenAPI tool runner, so its gaps have real reach.

**Evidence:** safeFetch.js:51-66 PRIVATE_IP_RE has no `/^100\.(6[4-9]|...)/`, no `/^22[4-9]|23\d/`, and no hex `::ffff:[0-9a-f]` case. ssrfGuard.js:34 `if (a === 100 && b >= 64 && b <= 127) return true;`, :38 `if (a >= 224) return true;`, and isPrivateIPv6Bytes:121 decodes `::ffff:` hex to embedded IPv4. webContentExtractor.js:13-27 is a separate weaker regex list.

**Recommended fix:** Delete the two regex copies and route all outbound user/LLM-influenced fetches (webContentExtractor, safeFetch/MCP, OpenAPI runner) through the single byte-based, DNS-pinned ssrfGuard, with per-hop redirect revalidation.

<sub>Verifier: Verified all three implementations. ssrfGuard.js:34/:38/:121 block CGNAT, multicast, and IPv4-mapped hex. safeFetch.js:51-66 regex omits 100.64/10, multicast, and any ::ffff:169.254 form (only 127/10/192.168/172 dotted). webContentExtractor.js:13-23 lacks all ::ffff mapped forms + no pinning. safeFe</sub>

---

### 85. Localized-string extraction logic reimplemented in ~15 places

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/toolLoader.js:100`
- `server/services/SourceResolutionService.js:197`
- `server/agents/profile/profileWorkflowSerializer.js:283`
- `server/agents/runtime/appAsToolGateway.js:65`
- `server/sources/SourceManager.js:271`
- `server/configCache.js:245`

**Problem:** The pattern 'pick value[lang] else value.en else Object.values(value)[0] else id' is copy-pasted across the codebase under many names: extractLanguageValue (toolLoader), getLocalizedValue (SourceResolutionService), localizedToString (profileWorkflowSerializer), localizedDescription (appAsToolGateway), plus 21 inline `.en || Object.values(x)[0]` occurrences (SourceManager, configCache, mcp handlers, workflow executors — the latter also flagged in the workflow-executors finding). Each variant handles the string-vs-object and fallback cases slightly differently, so bugs and behavior drift are easy.

**Evidence:** grep `Object.values(.*)[0]` in server hits 21 files. Named variants: toolLoader.js:100 extractLanguageValue, SourceResolutionService.js:197 getLocalizedValue, profileWorkflowSerializer.js:283 localizedToString, appAsToolGateway.js:65 localizedDescription. SourceManager.js:284-288 inline `result.name[language] || result.name.en || Object.values(result.name)[0] || result.id`.

**Recommended fix:** Create one shared server/utils/localize.js with `getLocalizedString(value, language, fallbackLang)` and replace the named variants and inline copies with it.

<sub>Verifier: All 6 cited sites verified verbatim: toolLoader.js:100 extractLanguageValue, SourceResolutionService.js:197 getLocalizedValue, profileWorkflowSerializer.js:283 localizedToString, appAsToolGateway.js:65 localizedDescription, SourceManager.js:284-288 and configCache.js:245 inline. A canonical getLocal</sub>

---

### 86. Five hand-rolled JSON persistence modules re-implement the same buffered-write pattern at different maturity levels

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/usageTracker.js:157`
- `server/shortLinkManager.js:39`
- `server/feedbackStorage.js:42`
- `server/services/UsageEventLog.js:15`
- `server/services/AuditLogService.js:97`

**Problem:** usageTracker (usage.json), shortLinkManager (shortlinks.json), feedbackStorage (feedback.jsonl), UsageEventLog (usage-events.jsonl), and AuditLogService (daily audit JSONL) each independently implement: module-level queue/dirty flag, a debounced scheduleSave/scheduleFlush setTimeout, a periodic setInterval safety-net flush, and retention cleanup. Fixes applied to one copy never reach the others: AuditLogService has timer.unref(), failure re-buffering, and a MAX_QUEUE overflow cap; feedbackStorage has a write lock and re-buffering; UsageEventLog has none of these (drops data, races, non-unref'd interval); usageTracker and shortLinkManager have non-unref'd intervals and the broken `error: e` logging.

**Evidence:** Identical shape: shortLinkManager.js:47-57 scheduleSave vs usageTracker.js:165-175 vs feedbackStorage.js:61-71 vs UsageEventLog.js:25-35 vs AuditLogService.js:97-110. Periodic intervals: usageTracker.js:435-440, shortLinkManager.js:183-188, feedbackStorage.js:182-188, UsageEventLog.js:148-154, AuditLogService.js:116-126 (only the last calls .unref()). AuditLogService.js:115 even says 'Mirrors UsageEventLog'.

**Recommended fix:** Extract one shared utility (e.g. server/utils/persistedStore.js with a debounced JSON store and a JsonlAppender: queue, re-buffer on failure, overflow cap, unref'd timers, write lock for read-modify-write cleanup) and port all five modules onto it.

<sub>Verifier: All 5 modules re-implement the buffered-write pattern at the cited lines: dirty/queue + debounced scheduleSave/scheduleFlush setTimeout + periodic setInterval. Maturity divergence verified: AuditLogService has unref (109,126), re-buffering (158-162), MAX_QUEUE (238-249); feedbackStorage has writeLoc</sub>

---

### 87. Single-shot LLM boilerplate and value/path helpers duplicated across workflow executors

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/services/workflow/executors/PromptNodeExecutor.js:914`
- `server/services/workflow/executors/HumanNodeExecutor.js:298`
- `server/tools/workflowRunner.js:31`
- `server/services/workflow/DAGScheduler.js:551`

**Problem:** Two duplication clusters. (a) The verify-key → executeStreamingRequest → parse pattern is re-implemented in PromptNodeExecutor, PlannerNodeExecutor._generatePlan, VerifierNodeExecutor, QuoteValidatorNodeExecutor, and QueryPlanNodeExecutor (each calls llmHelper.verifyApiKey + executeStreamingRequest independently). (b) Localized-value extraction is reimplemented as getLocalizedValue / _getLocalizedValue / resolveLocalized in 4+ files, and object/path traversal exists as four near-identical functions: BaseNodeExecutor.resolveVariable, DAGScheduler._getValueFromPath, PromptNodeExecutor.getNestedValue, and expressionEvaluator.resolvePath. (Cluster (b) overlaps the server-wide localized-string finding.)

**Evidence:** grep for _getLocalizedValue|getLocalizedValue|resolveLocalized|getNestedValue|_getValueFromPath → 41 occurrences across 6 files; verifyApiKey/executeStreamingRequest appear standalone in QuoteValidator:234, Verifier:241/295, QueryPlan:79/114, Planner:647/1017, Prompt:1489/1524.

**Recommended fix:** Add a shared `runSingleShotLLM({model,messages,tools,...})` helper on WorkflowLLMHelper for the non-tool-loop callers, and one localized-value + one path-resolver utility consumed by BaseNodeExecutor and the scheduler. Delete the per-file copies.

<sub>Verifier: Both clusters verified. (b) localized-value: near-identical helpers at PromptNodeExecutor.js:914, HumanNodeExecutor.js:298, workflowRunner.js:31, SourceResolutionService.js:197 (only empty-return differs ''/null). Path traversal: BaseNodeExecutor.resolveVariable:121 and expressionEvaluator.resolvePa</sub>

---

### 88. Deduplicate vLLM adapter and converter — near-verbatim copies of the OpenAI implementations

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/adapters/vllm.js:20`
- `server/adapters/openai.js:34`
- `server/adapters/toolCalling/VLLMConverter.js:165`
- `server/adapters/toolCalling/OpenAIConverter.js:129`
- `server/adapters/toolCalling/MistralConverter.js:70`

**Problem:** vllm.js duplicates openai.js almost line-for-line: formatMessages (vllm.js:20-76 vs openai.js:34-111), processResponseBuffer, and the enforceNoExtras schema walker copy-pasted a third time in openai-responses.js:197-213. VLLMConverter.js (514 lines) duplicates OpenAIConverter's tool-call conversion and full streaming state machine, differing only in schema sanitization and [DONE]-finalization; MistralConverter.js:70-72 proves the cheap alternative works (`convertMistralToolCallsToGeneric = convertOpenAIToolCallsToGeneric`). Bug fixes now need 3-4 synchronized edits — audio support was added to openai.js formatMessages but not vllm.js; the `error: e` bug was fixed in VLLMConverter but not OpenAI/Anthropic.

**Evidence:** vllm.js:41-47 comment 'Mirror OpenAIAdapter.formatMessages here so arrays and the data-URL wrapping behave the same way across providers' — acknowledging manual mirroring. VLLMConverter.js:165-238 is byte-similar to OpenAIConverter.js:129-238. enforceNoExtras appears at openai.js:155-171, openai-responses.js:197-213, vllm.js:158-171. Divergence bug: VLLMConverter.js:153 `function: { name: toolCall.id, ... }` uses the call id where OpenAIConverter.js:117 correctly uses `toolCall.name`.

**Recommended fix:** Make VLLMAdapter extend/parameterize OpenAIAdapterClass (override only chat_template_kwargs and tool conversion provider key); hoist enforceNoExtras into BaseAdapter; have VLLMConverter re-export OpenAIConverter functions Mistral-style, keeping only sanitizeSchemaForVLLM and the [DONE] finalization delta.

<sub>Verifier: Every citation verified. Image block vllm.js:48-70 is byte-identical to openai.js:55-79; vLLM lacks audio (openai.js:83-105) and getAudioFormat. processResponseBuffer (vllm.js:202-300 vs openai.js:203-297) near-identical. enforceNoExtras triplicated (openai.js:155, vllm.js:158, openai-responses.js:1</sub>

---

### 89. Deduplicate the four near-identical integration OAuth route files and drop the deprecated legacy callback

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/routes/integrations/office365.js:51`
- `server/routes/integrations/googledrive.js:56`
- `server/routes/integrations/nextcloud.js:51`
- `server/routes/integrations/jira.js:132`

**Problem:** office365.js (681 lines), googledrive.js (570), nextcloud.js (496) and jira.js (415) implement the same OAuth-provider pattern with copy-pasted handlers: `/auth` (session key, CSRF state, PKCE verifier, returnUrl validation), `/:providerId/callback` (state check, 15-min timeout, token exchange, `<provider>_error=` redirects), `/status`, `/disconnect`, plus rate limiters — word-for-word identical comments betray the copy-paste lineage. office365.js additionally keeps a ~125-line second callback handler marked '@deprecated Use /:providerId/callback instead'. Bodies differ only in the provider service object and `oauth_<provider>_` prefixes; every OAuth bugfix must be applied 4-5 times.

**Evidence:** Compare office365.js:51-118 `/auth` vs googledrive.js:56-120 vs nextcloud.js:51-97 — identical structure. Callback timeout `Date.now() - storedAuth.timestamp > 15 * 60 * 1000` verbatim in office365.js:188, googledrive.js:185, jira.js:132. Identical comment text at office365.js:141 and googledrive.js:141. office365.js:254-381: full duplicate legacy callback marked '@deprecated Use /:providerId/callback instead'.

**Recommended fix:** Extract a `createOAuthIntegrationRouter({ provider, service, usesPkce })` factory that builds auth/callback/status/disconnect and the rate limiter; each provider file becomes a few lines of config. Delete the deprecated office365 legacy callback (breaking change — ask owners first per project policy). Removes ~1500 lines.

<sub>Verifier: Verified against code. /auth handlers near-identical (office365.js:51, googledrive.js:56, nextcloud.js:51); timeout `Date.now()-storedAuth.timestamp>15*60*1000` verbatim at office365.js:188, googledrive.js:185, jira.js:132, nextcloud.js:161; comment block identical at office365.js:140-143 & googledr</sub>

---

### 90. Permission-enhancement boilerplate duplicated across route files (root cause of the anonymous gap)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/routes/generalRoutes.js:169`
- `server/routes/modelRoutes.js:81`
- `server/routes/chat/dataRoutes.js:388`
- `server/routes/toolRoutes.js:24`

**Problem:** The same ~8-line block — 'if (req.user && !req.user.permissions) enhance; if (!req.user && isAnonymousAccessAllowed) enhance(null)' — is copy-pasted into at least four route handlers to lazily build the anonymous principal and its permissions. This is fragile: it must be remembered in every new endpoint that filters by permission, and it was forgotten in the chat routes, directly producing the anonymous app-access bypass. It also duplicates the enhancement middleware in setup.js:631, which only handles the authenticated case.

**Evidence:** Identical pattern at generalRoutes.js:169-176, modelRoutes.js:81-88, dataRoutes.js:388-397, toolRoutes.js:24-31. setup.js:631 handles only `req.user && !req.user.permissions`.

**Recommended fix:** Move anonymous-principal creation + permission enhancement into one shared middleware applied before all permission-filtered routes (including chat), so req.user is always a fully-enhanced principal (anonymous or real). Delete the per-handler copies.

<sub>Verifier: Verified the identical ~8-line enhance block at generalRoutes.js:169-176, modelRoutes.js:81-88, toolRoutes.js:24-31, dataRoutes.js:388-397 (dataRoutes only differs by inlining authConfig). skillRoutes.js:24-28 is a 5th copy. setup.js:628-644 middleware indeed only handles req.user && !req.user.permi</sub>

---

### 91. Extract a generic admin resource list page — Apps/Models/Prompts pages are ~1700 lines of copy-paste CRUD

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AdminAppsPage.jsx:69`
- `client/src/features/admin/pages/AdminModelsPage.jsx:67`
- `client/src/features/admin/pages/AdminPromptsPage.jsx:84`
- `client/src/features/admin/pages/AdminToolsPage.jsx`
- `client/src/features/admin/pages/AdminWorkflowsPage.jsx`

**Problem:** AdminAppsPage (497 lines), AdminModelsPage (493) and AdminPromptsPage (691) implement the identical page: loadX, toggleX (POST .../toggle), enableAllX/disableAllX ('*' toggle), deleteX with ConfirmDialog, downloadXConfig (Blob + anchor download), handleUploadConfig (file-input JSON import with the same 'already exists'/SyntaxError branches), search+status filtering, header CTA row, and a DataTable with the same action set. AdminToolsPage and AdminWorkflowsPage repeat about half of it. Each new resource type re-copies ~400 lines; fixes (like the broken 'already exists' error check) must be applied 3-5 times and currently drift.

**Evidence:** grep counts 11 hits each for enableAll/disableAll/download/upload patterns in AdminAppsPage/AdminModelsPage/AdminPromptsPage. Compare AdminAppsPage.jsx:69-216 with AdminModelsPage.jsx:67-200 and AdminPromptsPage.jsx:84-200 — same function skeletons with the resource name substituted.

**Recommended fix:** Create a useAdminResourceList(resource) hook (load/toggle/toggleAll/delete/export/import) plus an AdminResourceListPage shell taking columns/actions as props; migrate the three main pages first. The never-adopted AdminListPage.jsx was already written for the layout half of this.

<sub>Verifier: Verified: downloadXConfig is byte-identical across all 5 (AdminAppsPage.jsx:168, AdminModelsPage.jsx:152, AdminPromptsPage.jsx:143, AdminToolsPage.jsx:90, AdminWorkflowsPage.jsx:127); handleUploadConfig repeats the same 'already exists'/SyntaxError branches in all 5; loadX/enableAll/disableAll/filte</sub>

---

### 92. Collapse the two parallel client admin API layers; delete dead duplicates in endpoints/admin.js

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `client/src/api/adminApi.js:5`
- `client/src/api/endpoints/admin.js:12`
- `client/src/api/index.js:6`

**Problem:** Two complete admin API client layers coexist: adminApi.js (1048 lines, hand-rolled makeAdminApiCall with adminToken fallback, no caching) and endpoints/admin.js (apiClient/handleApiResponse with ETag caching). Eleven functions are exported under identical names from both with different behavior: fetchAdminApps, fetchAdminPrompts, createPrompt, updatePrompt, and the entire skills CRUD. All page-level consumers import the adminApi.js variants; except fetchTools/fetchMcpToolCatalog (used by workflow editor forms), the endpoints/admin.js duplicates are dead code still star-re-exported through api/index.js — so which implementation (cached vs adminToken-aware) a component gets depends purely on its import path.

**Evidence:** 11 overlapping export names: createPrompt, deleteSkill, exportSkill, fetchAdminApps, fetchAdminPrompts, fetchAdminSkillDetail, fetchAdminSkills, importSkill, toggleSkill, updatePrompt, updateSkill. endpoints/admin.js:63-67 fetchAdminApps (cached, SHORT TTL) vs adminApi.js:146-149 (uncached, adminToken-aware). Skills CRUD duplicated at endpoints/admin.js:110-231 and adminApi.js:601-689. Grep finds zero importers of endpoints/admin.js's prompt/skills CRUD; AdminSkillsPage.jsx:6-12 and AdminPromptEditPage.jsx:13 import from adminApi. api/index.js:6 `export * from './endpoints/admin'` creates the name-collision hazard.

**Recommended fix:** Keep one layer: either delete the importer-less duplicates in endpoints/admin.js (moving fetchTools/fetchMcpToolCatalog into adminApi.js), or port adminApi.js's fetchers onto the handleApiResponse transport. Remove the `export *` from api/index.js and add an ESLint no-restricted-imports rule so each endpoint has exactly one implementation.

<sub>Verifier: Verified: adminApi.js:5 makeAdminApiCall (adminToken, uncached) and endpoints/admin.js:1-4 (apiClient/ETag cache) both define the same 11 names; behavior diverges (admin.js:63-68 cached vs adminApi.js:146-149). All live importers use ../api/adminApi (AdminSkillsPage:12, AdminAppsPage:10, etc.); grep</sub>

---

### 93. Deduplicate ~1500 lines of copy-pasted OAuth token-lifecycle scaffolding across GoogleDrive/Office365/Nextcloud services

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/services/integrations/GoogleDriveService.js:56`
- `server/services/integrations/Office365Service.js:32`
- `server/services/integrations/NextcloudService.js:41`

**Problem:** GoogleDriveService (943 lines), Office365Service (1124) and NextcloudService (723) each hand-roll the identical OAuth token lifecycle: _buildCallbackUrl, _getProviderConfig (same configCache lookup + credentialService.resolveSecret), the 3-step redirect-URI fallback chain, exchangeCodeForTokens, refreshAccessToken, storeUserTokens/getUserTokens with refresh-on-expiry and delete-on-failure, deleteUserTokens, and makeApiRequest with 401-retry-once. Divergence has produced real defects: security-hardened forwarded-header helpers were applied to Office365 and Nextcloud but not GoogleDrive; the `error: e` bug hides in only the Office365 copy (line 966); Office365Service:394-409 contains a dead 'invalidate old admin-consent scopes' block that logs but never invalidates anything.

**Evidence:** Method-for-method identical structure: GoogleDriveService.js:114-156 vs Office365Service.js:146-195 (generateAuthUrl with the same three-tier redirectUri fallback and identical log strings 'Using fallback localhost URL for ... callback'); GoogleDriveService.js:442-510 vs Office365Service.js:511-635 (makeApiRequest 401-retry). NextcloudService.js:92-112 _resolveRedirectUri is the same fallback extracted locally. Office365Service.js:396-409: comment says 'These tokens need to be invalidated' but the if-block only calls logger.warn.

**Recommended fix:** Extract a shared OAuthIntegrationBase (callback-URL building, redirect-URI resolution, token store/refresh/expiry/401-retry) parameterized by provider endpoints and scopes; keep only Graph/Drive/WebDAV-specific API methods in each service. Delete the dead scope-invalidation block or implement it.

<sub>Verifier: Every claim verified against code. Duplication real: near-identical _buildCallbackUrl/_getProviderConfig/generateAuthUrl/exchangeCodeForTokens/makeApiRequest across GoogleDrive/Office365/Nextcloud (GoogleDrive:442-510 vs Office365:511-635; identical fallback log strings). Divergence confirmed: Offic</sub>

---

### 94. Delete the deprecated per-adapter processResponseBuffer parsers — every provider has two divergent response parsers

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/adapters/openai.js:203`
- `server/adapters/anthropic.js:226`
- `server/adapters/google.js:576`
- `server/adapters/mistral.js:115`
- `server/adapters/vllm.js:202`
- `server/adapters/openai-responses.js:249`
- `server/adapters/toolCalling/README.md:213`
- `server/services/chat/ChatService.js:340`

**Problem:** Each provider carries two full wire-format parsers: adapter.processResponseBuffer (~100-250 lines each, ~1100 lines total) and the toolCalling converter's convertXResponseToGeneric. The converters own the live streaming path; the adapters' copies survive only for a fallback in ChatService.invokeAppInternal and tests, and the module's own README declares them deprecated. They have already diverged: anthropic.js:270 only reads `parsed.content[0]?.text` (drops multi-block text and all tool_use blocks in full responses), google.js's copy has its own finish-reason mapping, and openai-responses.js parses event shapes the converter no longer matches. Biggest maintainability hazard in the adapter layer.

**Evidence:** toolCalling/README.md:213 "**`processResponseBuffer` deprecated** - Use `convertResponseToGeneric` instead". Only production consumer: ChatService.js:340 `processResponseBuffer(model.provider, JSON.stringify(rawBody))`. Divergence: anthropic.js:270 `if (parsed.content && Array.isArray(parsed.content) && parsed.content[0]?.text)` vs AnthropicConverter.js:208-232 which iterates all blocks including tool_use. utils.js:565 simpleCompletion already uses convertResponseToGeneric for the same job.

**Recommended fix:** Switch ChatService.js:340 to convertResponseToGeneric (as simpleCompletion already does), keep iassistant-conversation's processResponseBuffer (its line-delimited parser genuinely needs it), delete the other six implementations plus the adapters/index.js processResponseBuffer export, and update tests to target the converters.

<sub>Verifier: Verified: each cited provider has both an adapter processResponseBuffer and a toolCalling convert*ResponseToGeneric (openai.js:203, anthropic.js:226, google.js:576, mistral.js:115, vllm.js:202, openai-responses.js:249). Live streaming uses the converters (BaseAdapter.js:172,234; ToolExecutor.js:925)</sub>

---

### 95. Consolidate copy-paste CRUD across apps/models/prompts/tools/sources into a resource-route factory — drift is already causing bugs

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** large  
**Labels:** `duplication` `sev:medium`

**Files:**
- `server/routes/admin/apps.js:623`
- `server/routes/admin/models.js:203`
- `server/routes/admin/prompts.js:546`
- `server/routes/admin/tools.js:438`
- `server/routes/admin/sources.js:558`
- `server/utils/responseHelpers.js:103`

**Problem:** apps.js, models.js, prompts.js, tools.js and sources.js each hand-roll the same list/get/create/update/delete/toggle/batch pipeline (validateIdForPath → configCache read → validate → write → refresh cache → snapshot → audit) and have drifted: apps PUT uses atomicWriteJSON while apps POST/toggle and all of models/prompts/tools use plain fs.writeFile (crash mid-write corrupts config); sources duplicates identical validateIdForPath blocks in three routes; models re-implements 'exactly one default model' five ways despite modelsLoader.ensureOneDefaultModel; Zod schemas exist but writes never enforce them; responseHelpers' asyncHandler/createRouteHandler are exported but unused. resourceLoader.js proves the factory pattern already worked for loading.

**Evidence:** apps.js:623 `await atomicWriteJSON(appFilePath, updatedApp)` vs models.js:203 `await fs.writeFile(modelFilePath, JSON.stringify(updatedModel, null, 2))` and prompts.js:546 same; sources.js:558-566 two consecutive identical `validateIdForPath(id, 'source', res)` blocks (also 836-843, 988-995); models re-implements default-model logic at 186-196, 270-280, 312-325, 376-382, 416-428; grep shows zero usages of asyncHandler/createRouteHandler outside responseHelpers.js; resourceLoader.js:13 "This eliminates the duplication between appsLoader, modelsLoader, and promptsLoader."

**Recommended fix:** Build a createAdminResourceRoutes({resource, dir, schema, hooks}) factory (mirror of createResourceLoader) that owns validation (including Zod enforcement on write), atomic writes, cache refresh, snapshot/audit, and route ordering; migrate apps/models/prompts first, then tools/sources with per-resource hooks.

<sub>Verifier: Every cited fact verified. Write drift real: apps.js:623 atomicWriteJSON vs models.js:203/prompts.js:546/tools.js:438 plain fs.writeFile; apps POST/toggle (746/838/961) also non-atomic. sources.js has literal duplicate validateIdForPath blocks (558-566, 836-843, 988-995). models default logic repeat</sub>

---

### 96. Remove duplicate 2.6 MB mermaid bundle at docs/ root (theme/ copy is the referenced one)

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:low`

**Files:**
- `docs/mermaid.min.js`
- `docs/mermaid-init.js`
- `docs/book.toml:14`

**Problem:** Two full mermaid vendor bundles are checked in under docs/: docs/mermaid.min.js (2.6 MB) plus docs/mermaid-init.js at the docs root, and docs/theme/mermaid.min.js (3.2 MB) plus theme/mermaid-init.js. book.toml only references the theme/ copies, so the root copies are dead — and md5 sums show they are DIFFERENT versions, so anyone 'updating mermaid' can touch the wrong file and see no effect. Because book.toml sets `src = "."`, mdbook copies the dead root bundle into the built docs, which docs:copy:all then ships into every dist/ build.

**Evidence:** md5sum: docs/mermaid.min.js ee4516... vs docs/theme/mermaid.min.js 1156de... (different); docs/mermaid-init.js 2d68c5... vs theme copy ed1ae5... (different). docs/book.toml:14 references only theme/ paths (`additional-js = ["theme/mermaid.min.js", "theme/mermaid-init.js"]`); grep for 'mermaid.min.js' in docs *.md/*.hbs finds no non-theme reference.

**Recommended fix:** Delete docs/mermaid.min.js and docs/mermaid-init.js; keep only the theme/ copies referenced by book.toml. Consider fetching mermaid at docs-build time instead of vendoring 3 MB into git.

<sub>Verifier: All claims verified. docs/mermaid.min.js (2.6M) + docs/mermaid-init.js are duplicates of docs/theme/ copies (3.2M) with DIFFERENT md5s (ee4516 vs 1156de; 2d68c5 vs ed1ae5) — genuinely divergent versions. docs/book.toml:14 loads only theme/ paths; grep across *.md/*.hbs/*.html/*.js (incl. head.hbs) f</sub>

---

### 97. StatusBadge and ProgressBar re-implemented in four places

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:low`

**Files:**
- `client/src/features/tools/pages/OcrPage.jsx:35`
- `client/src/features/tools/pages/JobListPage.jsx:6`
- `client/src/features/workflows/components/StatusBadge.jsx`
- `client/src/features/workflows/components/ProgressBar.jsx`

**Problem:** OcrPage.jsx (lines 35-70) and JobListPage.jsx (lines 6-43) each define their own local StatusBadge and ProgressBar with an identical status→Tailwind-color map (queued/processing/building/completed/error/cancelled), while the workflows feature has its own exported StatusBadge and ProgressBar components. Four parallel implementations of the same status color semantics guarantee drift (the two tools pages' maps are already copy-pasted verbatim between the files).

**Evidence:** JobListPage.jsx:7-14 and OcrPage.jsx:54-61 contain the identical `colors = { queued: 'bg-gray-100 text-gray-800 dark:bg-gray-700...', processing: 'bg-blue-100...', ... }` object; both files also define local `ProgressBar({ value, max })` with the same pct math (OcrPage.jsx:35-51, JobListPage.jsx:30-43). workflows/components/StatusBadge.jsx and ProgressBar.jsx are separate exported variants.

**Recommended fix:** Move a configurable StatusBadge and ProgressBar into shared/components and reuse them from the tools pages (and, where the prop shapes allow, the workflows feature).

<sub>Verifier: Verified: OcrPage.jsx:54-61 and JobListPage.jsx:7-14 have byte-identical StatusBadge color maps and identical span markup (verbatim copy-paste); both share identical pct math in local ProgressBar. workflows/StatusBadge.jsx & ProgressBar.jsx exist and are exported. Real duplication confirmed. Caveat:</sub>

---

### 98. Duplicated user-loading and password-hashing implementations across auth modules

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:low`

**Files:**
- `server/utils/userManager.js:19`
- `server/middleware/localAuth.js:20`
- `server/middleware/localAuth.js:45`
- `server/utils/rehashPasswords.js:16`

**Problem:** Two separate loadUsers() implementations exist: userManager.js reads through configCache while localAuth.js re-implements a direct fs.readFileSync loader that bypasses the cache — loginUser() uses the localAuth copy, so password checks and the rest of the app read users through different code paths with different caching semantics. hashPasswordWithUserId() is also implemented verbatim twice, in localAuth.js and the standalone rehashPasswords.js script (which additionally hardcodes demo passwords 'password123' and rewrites users.json non-atomically; its only reference is docs/troubleshooting.md). Divergent hashing copies risk incompatible hashes if one is updated (e.g. cost factor change).

**Evidence:** userManager.js:19 `export function loadUsers` (cache-based, 90 lines) vs localAuth.js:20 `function loadUsers` (direct fs read, 18 lines). Identical hashPasswordWithUserId at localAuth.js:45 and rehashPasswords.js:16 (same bcrypt.genSalt(12) + `${userId}:${password}` body). rehashPasswords.js:39-42 `knownPasswords = { user_demo_admin: 'password123', ... }`; only doc reference docs/troubleshooting.md:294.

**Recommended fix:** Export one loadUsers and one hashPasswordWithUserId from a single module and import everywhere; delete the localAuth duplicates (deciding explicitly whether password verification needs a cache-bypassing read). Have rehashPasswords.js import the shared hash, move it under scripts/ and read passwords from args/env — or delete it if obsolete.

<sub>Verifier: All claims verified. userManager.js:19 exports a cache-based loadUsers (lines 19-107); localAuth.js:20 is a private direct-fs loader (lines 20-37) used by loginUser (line 93), diverging from jwtAuth.js/adminRescue.js which use the cached one. hashPasswordWithUserId is verbatim in localAuth.js:45 and</sub>

---

### 99. ID-validation regex /^[a-zA-Z0-9._-]+$/ duplicated across validators and route handlers

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:low`

**Files:**
- `server/utils/pathSecurity.js:20`
- `server/validators/mcpServerConfigSchema.js:11`
- `server/validators/credentialSchema.js:20`
- `server/validators/sourceConfigSchema.js:20`
- `server/validators/openApiToolDefSchema.js:68`
- `server/validators/groupConfigSchema.js:9`

**Problem:** The canonical safe-ID pattern lives in pathSecurity.js as SAFE_ID_PATTERN (/^[a-zA-Z0-9._-]+$/), but the identical literal is re-declared in at least five Zod schemas plus ad-hoc route checks (browserExtension.js:429, workflowRoutes.js:2473). If the allowed character set ever changes (e.g. to forbid dots for path safety), these drift independently and IDs validated by one path may be rejected/accepted by another.

**Evidence:** pathSecurity.js:20 `const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/`. sourceConfigSchema.js:20 and :93, credentialSchema.js:20, mcpServerConfigSchema.js:11, openApiToolDefSchema.js:68, groupConfigSchema.js:9 each re-inline the same regex.

**Recommended fix:** Export a shared Zod id schema (e.g. `zSafeId` in validators/index.js) built from the single SAFE_ID_PATTERN and reuse it across schemas; use validateIdForPath/isValidId for route-level checks.

<sub>Verifier: Core claim verified: identical literal /^[a-zA-Z0-9._-]+$/ is inlined in mcpServerConfigSchema.js:11, credentialSchema.js:20, sourceConfigSchema.js:20+:93, openApiToolDefSchema.js:68, groupConfigSchema.js:9, while pathSecurity.js:20 defines SAFE_ID_PATTERN (module-private, only isValidId() exported)</sub>

---

### 100. Consolidate four hand-rolled SSE endpoint implementations into one connection helper

**Severity:** low · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `duplication` `sev:low`

**Files:**
- `server/routes/chat/sessionRoutes.js:348`
- `server/routes/agents/runs.js:523`
- `server/routes/workflow/workflowRoutes.js:1592`
- `server/routes/toolsService/jobRoutes.js:33`
- `server/sse.js:6`

**Problem:** Four SSE endpoints each reimplement the same connection lifecycle: the 4-header setup block (text/event-stream, no-cache, keep-alive, X-Accel-Buffering), a module-level client Map keyed by id (`clients`, `agentClients`, `workflowClients`), the subtle 'pin this registration so a stale close handler can't delete a fresh entry' pattern (independently re-invented with near-identical comments in three files), heartbeats, and close/teardown handling. Chat additionally has dead-socket teardown in sse.js and cleanupInactiveClients in serverHelpers.js which the other maps don't get — so agent/workflow maps can leak entries chat wouldn't. utils/sseEmitter.js consolidates only the emit side, not the connection side.

**Evidence:** Identical header blocks: sessionRoutes.js:348-351, runs.js:523-526, workflowRoutes.js:1592-1595, jobRoutes.js:33-38. Pinned-entry idiom: sessionRoutes.js:353-356 ('Pin this registration so a stale close handler ... can't delete a fresh entry') vs workflowRoutes.js:1602-1604 (same comment text) vs runs.js:529 `const myEntry = agentClients.get(runId)`. Heartbeat + close teardown duplicated at runs.js:609-627. Only chat's map is swept: serverHelpers.js:54-58 iterates `clients` from sse.js.

**Recommended fix:** Create `createSseChannel({ map, keepAliveMs, onClose })` in server/utils (next to sseEmitter.js) that sets headers, registers a pinned entry, runs the heartbeat, wires req.on('close'), and exposes send(). Adopt it in all four routes; give every channel the same dead-client sweeping.

<sub>Verifier: Every citation checks out: identical 4-header setup (sessionRoutes.js:348-351, runs.js:523-526, workflowRoutes.js:1592-1595, jobRoutes.js:33-38 via writeHead); three Maps + pin idiom (sse.js:1, runs.js:512/529, workflowRoutes.js:48/1608); heartbeat/close teardown (runs.js:609-627, workflowRoutes.js:</sub>

---

### 101. AuthContext: loginLocal/loginLdap are a 130-line copy-paste and logout cleanup uses require() that always throws

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `duplication` `sev:low`

**Files:**
- `client/src/shared/contexts/AuthContext.jsx:411`
- `client/src/shared/contexts/AuthContext.jsx:605`

**Problem:** loginLocal (411-473) and loginLdap (476-543) are byte-for-byte identical except for endpoint and an optional provider field: same cookie/token handling, cache clearing, returnUrl redirect, error extraction; loginWithToken (213-267) repeats the returnUrl block a third time. Separately, performLogoutCleanup (line 605) calls CommonJS `require('../../api/utils/cache')` in browser ESM code — require is undefined in the Vite bundle, so the statement throws on every logout (silently caught at 607) and clearApiCache() never runs; the three login paths correctly use `await import(...)`. Exposure is masked only because logout() ends in a full page reload.

**Evidence:** AuthContext.jsx:420 `apiClient.post('/auth/local/login', requestBody)` vs :490 `apiClient.post('/auth/ldap/login', requestBody)` — surrounding 60 lines identical (compare 424-473 with 494-543). Line 605: `const { clearApiCache } = require('../../api/utils/cache');` inside performLogoutCleanup; the same operation is done via dynamic import at lines 230, 433, 503.

**Recommended fix:** Extract a single `loginWithCredentials(endpoint, body)` helper used by both methods, and a shared `redirectToReturnUrl()` helper. Replace the `require()` with the same `await import()` used elsewhere (or drop the call since the reload clears the cache — but then delete the dead statement).

<sub>Verifier: Both claims verified. loginLocal (AuthContext.jsx:411-473) and loginLdap (476-543) are substantially duplicated (differ only in endpoint, optional provider block, error strings); loginWithToken repeats the returnUrl block. Line 605 uses require() in a Vite ESM bundle ("type":"module", vite 8) where </sub>

---

## 🗑️ Dead Code

### 102. Delete ~2,370 lines of unreferenced client components and hooks (20 files, incl. admin UI kit, canvas hooks, NDAResultsRenderer)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:medium`

**Files:**
- `client/src/features/admin/components/AdminAuth.jsx`
- `client/src/features/admin/components/AdminButton.jsx`
- `client/src/features/admin/components/AdminInput.jsx`
- `client/src/features/admin/components/AdminListPage.jsx`
- `client/src/features/admin/components/AdminSectionCard.jsx`
- `client/src/features/admin/components/AdminSectionTitle.jsx`
- `client/src/features/admin/components/AdminSelect.jsx`
- `client/src/features/admin/components/LoggingConfig.jsx`
- `client/src/features/admin/components/QuickActions.jsx`
- `client/src/features/admin/components/SourceContentEditor.jsx`
- `client/src/features/canvas/hooks/useCanvasContent.js`
- `client/src/features/canvas/hooks/useCanvasEditResult.js`
- `client/src/features/canvas/hooks/useCanvasEditing.js`
- `client/src/features/chat/components/ClarificationResponse.jsx`
- `client/src/features/chat/components/ExportConversationMenu.jsx`
- `client/src/features/nextcloud-embed/hooks/useNextcloudConnection.js`
- `client/src/features/office/hooks/useOutlookMailContext.js`
- `client/src/features/workflows/components/WorkflowPreview.jsx`
- `client/src/features/workflows/index.js`
- `client/src/shared/components/renderers/NDAResultsRenderer.jsx`
- `server/defaults/renderers/nda-results.jsx`

**Problem:** Twenty client files (~2,370 lines) are imported by nothing, verified via full import-graph resolution over all 450 client files (all Vite entries: main, office, extension, nextcloud) plus repo-wide basename grep for string/dynamic references. Notable: a parallel admin UI kit (AdminButton/Input/Select/ListPage/SectionCard/SectionTitle — docstring says 'Adopt incrementally') that every admin page still hand-rolls inline; three canvas hooks superseded by the unified useCanvas.js; QuickActions.jsx shadowed by a local function in AdminOverview.jsx:175; NDAResultsRenderer.jsx duplicating the live server/defaults/renderers/nda-results.jsx fetched at runtime via /api/renderers/:id; useOutlookMailContext.js superseded by its Snapshot variant.

**Evidence:** Import graph: 450 code files, these unreferenced; per-file greps confirm, e.g. `grep -rn "useOutlookMailContext\b" client/src | grep -v Snapshot` → only itself; AdminInput mentioned once, in a comment inside equally-dead AdminSelect.jsx:2; no barrel re-exports. CustomResponseRenderer.jsx:35 `fetch(\`/api/renderers/${componentName}\`)` proves renderers load from the server, not client/src/shared/components/renderers/. AppCanvas.jsx:494 comment 'handled by useCanvasContent hook' is stale — the hook is never imported.

**Recommended fix:** Delete all 20 client files (and the now-empty renderers/ folder), remove the stale AppCanvas.jsx:494 comment and AdminSelect's AdminInput mention; server/defaults/renderers/nda-results.jsx remains the single source. If the admin UI kit was the intended direction, adopt it across admin pages instead — pick one, don't keep both.

<sub>Verifier: Verified all 20 client files have zero external refs (no barrel index in admin/components, no import.meta.glob, no path imports). Ambiguous cases hold: AdminAuth≠AdminAuthPage, LoggingConfig hits were setLoggingConfig, QuickActions shadowed by local fn (AdminOverview.jsx:175), useOutlookMailContext </sub>

---

### 103. Sweep one-off scripts, manual-test artifacts, dev configs, and fix-summary docs from repo root, tests/, and scripts/

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `test-locale-api.js:1`
- `test-locale-override.js:1`
- `nginx.conf:6`
- `TESTING_OIDC_SUBPATH.md`
- `tests/manual-test-provider-apikey-persistence-fix.js`
- `tests/IMPLEMENTATION_SUMMARY.md`
- `tests/test-resend-fix.md`
- `scripts/create-usability-issues.sh:1`

**Problem:** One-off 'tried until it worked' artifacts clutter the tree: root test-locale-api.js/test-locale-override.js write throwaway files into contents/locales and are referenced by no npm script, jest testMatch, CI workflow, or doc; root nginx.conf is a developer's local macOS config (homebrew include) referenced by no compose file, Dockerfile, or script; TESTING_OIDC_SUBPATH.md documents a long-shipped 2025 OIDC fix; tests/ holds eight manual-test-*.js one-offs, demo HTML/JS, and fix write-ups (IMPLEMENTATION_SUMMARY.md, test-resend-fix.md, MODEL_TESTING_PROVIDER_KEY_FIX.md); scripts/create-usability-issues.sh is an already-executed one-shot gh-issue batch. This obscures which tests are real.

**Evidence:** `grep -rn "test-locale" .` (excl. node_modules) → zero references; jest testMatch is '**/tests/**/*.test.js'; test-locale-api.js:12-16 writes contents/locales/en.json. nginx.conf:6 `include /opt/homebrew/etc/nginx/mime.types;`. ls tests/ shows 8 manual-test-*.js, demo-ai-disclaimer-banner-fix.html and fix write-ups — none in package.json scripts or .github/workflows. create-usability-issues.sh:2 'Create GitHub issues for iHub Apps usability simplification roadmap'.

**Recommended fix:** Delete these files (git history preserves them); port the locale-merge checks to real unit tests under tests/; move still-useful manual checks to tests/manual/ with a README; relocate fix write-ups and TESTING_OIDC_SUBPATH.md to concepts/ per project convention. If docker/nginx.conf is a reference config, move it under docs/ or examples/.

<sub>Verifier: Verified: `grep "test-locale"` → 0 refs; both write into contents/ (test-locale-api.js:14,24). jest testMatch (tests/config/jest.config.js:35-39) is narrower than claimed and excludes all manual-test-*.js/root scripts. Manual tests, demos, fix-writeups absent from package.json+.github/workflows. cre</sub>

---

### 104. Remove client/src/api/api.js re-export shim creating two import paths for the same module

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `client/src/api/api.js:1`

**Problem:** client/src/api/api.js is a 2-line `export * from './index'` shim that creates a second import path for the same module. Note: it is not strictly dead — both paths ARE used, inconsistently, sometimes within the same file — but it is a purposeless abandoned-indirection layer that misleads readers about which path is canonical, so severity is kept low.

**Evidence:** api/api.js: `export * from './index';`. AdminPromptEditPage.jsx:14-15 imports from both '../../../api/api' and '../../../api' in the same file.

**Recommended fix:** Delete api/api.js and codemod its ~30 importers to import from '../../api' (the index) directly.

<sub>Verifier: Verified all claims. api/api.js:2 is `export * from './index'` — a re-export shim over the modular api/index.js. Both paths are live: `../api/api` in 27 files, `../api` in 5. AdminPromptEditPage.jsx:14-15 imports from both in one file (clearApiCache from '../../../api/api', fetchUIConfig from '../..</sub>

---

### 105. Redundant top-level searchStatus state in useAppChat is never consumed

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `client/src/features/chat/hooks/useAppChat.js:37`
- `client/src/features/chat/hooks/useAppChat.js:723`

**Problem:** useAppChat keeps a top-level searchStatus state that is set on every search.status event and returned from the hook, but no consumer reads it — AppChat, AppCanvas and ComparePanel never destructure searchStatus. The UI reads the per-message copy (message.searchStatus) instead, which the same handler already writes. The standalone state and its setSearchStatus(null) resets are dead.

**Evidence:** useAppChat.js:37 `const [searchStatus, setSearchStatus] = useState(null);` and returned at 723; ChatMessage.jsx:570 uses `message.searchStatus` for SearchStatusIndicator. Grep for searchStatus in AppChat/AppCanvas/ComparePanel finds no reads.

**Recommended fix:** Drop the top-level searchStatus state and its return; keep only the message-level field written via updateAssistantMessage.

<sub>Verifier: Verified: useAppChat.js:37 declares top-level searchStatus state, returned at :723. setSearchStatus fires at :260/:334/:714. The same handler writes the per-message copy at :264, which is what ChatMessage.jsx:570-571 renders. All consumers fail to read the top-level value: AppChat.jsx:421-435 and Ap</sub>

---

### 106. Remove dead TokenStorageService.getUserServices (broken after per-provider migration) and false 'legacy base64' claims

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `server/services/TokenStorageService.js:507`
- `server/services/TokenStorageService.js:604`

**Problem:** getUserServices is referenced nowhere in the repo (grep across server/, client/, shared/ finds only its definition) and it is also broken: it probes only the legacy `${userId}.json` path, which migrateLegacyTokenFiles renames to `${userId}__${providerId}.json` at startup, so it would return an empty list on any migrated install. Additionally, decryptString's and isEncrypted's docblocks claim support for a 'legacy base64 format' that does not exist — isEncrypted only recognizes ENC[...], and _decrypt slices assuming the ENC[ envelope, so a legacy base64 value would produce garbage.

**Evidence:** TokenStorageService.js:513 `const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);` — no `__${providerId}` variant checked, while :851 migration skips files containing '__' and renames the rest. Grep for getUserServices: single hit (definition). :605-606 doc: 'Supports both new ENC[...] format and legacy base64 format' vs :684-688 which returns true only for `value.startsWith('ENC[')`.

**Recommended fix:** Delete getUserServices, and fix the decryptString/isEncrypted docblocks to state only the ENC[...] format is supported.

<sub>Verifier: All three claims verified. getUserServices (TokenStorageService.js:507) has no callers repo-wide (grep: only definition + a concept .md). It probes only `${userId}.json` (:513) while new/migrated files are `${userId}__${providerId}.json` (:255, renamed at :952, `__` skipped at :851), so it returns [</sub>

---

### 107. Remove the deprecated legacy Office 365 /callback route

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `server/routes/integrations/office365.js:258`

**Problem:** The legacy provider-agnostic `/callback` handler (~125 lines) is explicitly `@deprecated` in favor of `/:providerId/callback` and only differs by iterating session keys to find one whose `.state` matches. It duplicates the entire token-exchange/redirect logic of the supported route and is a maintenance liability (state-matching across arbitrary session keys is also a weaker validation path). No provider config should point at it if redirect URIs are provider-specific.

**Evidence:** Line 254-257 comment: `@deprecated Use /:providerId/callback instead`. Handler at 258-383 re-implements office365.js:124-251 with a `for (const key of Object.keys(req.session)) { if (key.startsWith('oauth_office365_') && req.session[key]?.state === state)` scan.

**Recommended fix:** Confirm no configured Office 365 provider uses a redirect_uri without providerId, then delete the legacy route (and fold the remaining unique logic into the provider-specific handler if any deployment still needs it).

<sub>Verifier: Verified in office365.js: lines 253-257 carry the `@deprecated Use /:providerId/callback` comment; handler at 258-383 (126 lines) duplicates the supported handler at 124-251 (token exchange, refresh-token check, storeUserTokens, timeout, redirects), differing only by the session-key scan at 269-275.</sub>

---

### 108. Dead no-op statements in chat and magic-prompt handlers

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `server/routes/chat/sessionRoutes.js:483`
- `server/routes/magicPromptRoutes.js:25`

**Problem:** Two statements have no effect. In processChatRequest, `const {} = prep;` (line 483) destructures nothing and does nothing. In the magic-prompt handler, `req.headers['accept-language']?.split(',')[0] || defaultLang;` (line 25) computes a value and discards it — the intended language variable is never assigned, so the computed default language is thrown away. These are leftovers from iterative development.

**Evidence:** chat/sessionRoutes.js:483 `const {} = prep;`. magicPromptRoutes.js:24-25: `const defaultLang = ...; req.headers['accept-language']?.split(',')[0] || defaultLang;` (result unused).

**Recommended fix:** Delete the empty destructure. In magicPromptRoutes, either remove the dead expression or assign it to a `language` variable if it was meant to be used.

<sub>Verifier: Verified both. sessionRoutes.js:483 `const {} = prep;` is empty destructuring = no-op; prep is used later (prep.tools L490, prep.request L519), so line adds nothing. magicPromptRoutes.js:25 is a bare expression statement discarding its result; grep confirms defaultLang appears only on L24-25 and no </sub>

---

### 109. Electron desktop target is a broken stub — packaged app cannot start

**Severity:** low · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `dead-code` `sev:low`

**Files:**
- `electron/main.js:12`
- `electron/main.js:30`
- `electron/main.js:36`
- `electron/preload.js:3`
- `package.json:182`

**Problem:** The advertised `electron:build` flow (README/CLAUDE.md) cannot produce a working app. Root package.json has no `main` field, so Electron/electron-builder falls back to a nonexistent index.js. The builder packs `dist/**` and `electron/**` into an asar, yet main.js spawns `node` on a path that only exists inside app.asar (and spawning assumes end users have Node installed). The window loads the SPA via loadFile, from which relative /api fetches to the localhost server cannot work. preload.js exposes an empty electronAPI. The target consumes ~200MB of electron+electron-builder devDependencies for no working output.

**Evidence:** package.json has no `main` key (verified lines 1-198); electron/main.js:12 `return path.join(process.resourcesPath, 'dist', 'server', 'server.js')` and :36 `spawn('node', [getServerEntry()], ...)`; :30 `win.loadFile(path.join(process.resourcesPath, 'dist', 'public', 'index.html'))`; electron/preload.js:3 `contextBridge.exposeInMainWorld('electronAPI', {});` — the entire preload surface.

**Recommended fix:** Decide: delete the electron/ target and its devDependencies/scripts, or fix it properly (add `main`, ship the server via extraResources or fork inside Electron, load the UI from http://localhost:PORT). Ask the owners which; deleting is the cleanest given zero users can currently use it.

<sub>Verifier: All facts verified. package.json (1-198) has no `main`; no root index.js, no electron-builder config, so `electron:build` defaults to nonexistent index.js — fatal. main.js:12/:36 spawn external `node` on an in-asar path (files:`dist/**/*`,asar:true → resourcesPath/dist/... doesn't exist). main.js:30</sub>

---

### 110. Remove unused npm dependencies from root, client, and server package.json

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `package.json:123`
- `package.json:128`
- `package.json:131`
- `package.json:134`
- `package.json:135`
- `package.json:150`
- `package.json:159`
- `package.json:160`
- `package.json:164`
- `client/package.json:29`
- `client/package.json:43`
- `client/package.json:46`
- `server/package.json:33`

**Problem:** Dependencies imported by no code: html-to-image, react-icons, react-resizable-panels are declared in BOTH root and client package.json (at divergent versions) with zero import hits repo-wide. Root also duplicates @monaco-editor/react and file-saver, which only client code imports. Because `build:package` runs `npm ci --omit=dev` on root package.json inside dist/, these front-end libraries ship into every production server deployment. server/package.json declares never-imported cached-dns. Root devDependencies esbuild, postject, nodemon, and vitest are used by no script or config (no vitest config exists; the repo standardized on Jest/Playwright/node:test; build-sea.cjs avoids postject).

**Evidence:** `grep -rE "html-to-image|react-icons|react-resizable-panels"` across client/src, client/office, client/extension, shared, server, electron, browser-extension, scripts, tests → zero hits. `grep -rn cached-dns` → only server/package.json + lock. grep vitest excluding lockfiles → only package.json:164. build-sea.cjs:3 'avoids postject issues'. package.json:39 `build:package: cd dist && npm ci --omit=dev` installs root deps into the shipped server.

**Recommended fix:** Uninstall html-to-image, react-icons, react-resizable-panels from root and client; @monaco-editor/react, file-saver, esbuild, postject, nodemon, vitest from root; cached-dns from server. Keep root gpt-tokenizer/dotenv/http(s)-proxy-agent — dist/shared and dist/server resolve them from root node_modules. Re-run builds to confirm.

<sub>Verifier: Verified every claim. html-to-image, react-icons, react-resizable-panels have zero code imports (only a dead vite.config.js:64 manualChunks hint for react-icons). @monaco-editor/react + file-saver imported only in client/src; root copies (package.json:123,128) are unused. cached-dns (server:33) only</sub>

---

### 111. SourceResolutionService cache is dead weight: new instance per request, plus an unused SourceManager built in the constructor

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `server/services/SourceResolutionService.js:19`
- `server/services/PromptService.js:283`

**Problem:** PromptService creates `new SourceResolutionService()` inside processMessageTemplates on every chat request. The service's resolutionCache with 5-minute TTL, plus clearCache() and getCacheStats(), can therefore never have a hit — the Map dies with each request. The constructor also calls createSourceManager() and stores this.sourceManager, which is never referenced again anywhere in the class (PromptService builds its own separate SourceManager at line 297). Caching machinery that looks functional but is provably inert.

**Evidence:** SourceResolutionService.js:19-21 `this.sourceManager = createSourceManager(); this.resolutionCache = new Map(); this.cacheTimeout = 5 * 60 * 1000;` — grep shows `sourceManager` appears only on line 19. PromptService.js:283 `const sourceResolutionService = new SourceResolutionService();` inside the per-request path.

**Recommended fix:** Either export a module-level singleton (making the TTL cache real, with invalidation on sources.json reload) or delete resolutionCache/clearCache/getCacheStats and the unused this.sourceManager entirely. Given configCache already caches sources, deletion is simpler.

<sub>Verifier: All claims verified. PromptService.js:283 and PromptNodeExecutor.js:1343 both do inline `new SourceResolutionService()` per request; grep found no singleton. So resolutionCache (SourceResolutionService.js:20-21) is rebuilt/discarded per call and resolveAppSources runs once per instance — the line 44</sub>

---

### 112. Remove dead code: toolFormatter.js and the unused cross-provider conversion API surface in toolCalling

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `dead-code` `sev:low`

**Files:**
- `server/adapters/toolFormatter.js:1`
- `server/adapters/toolCalling/ToolCallingConverter.js:190`
- `server/adapters/toolCalling/index.js:84`
- `server/adapters/toolCalling/AnthropicConverter.js:336`
- `server/adapters/toolCalling/GoogleConverter.js:441`

**Problem:** toolFormatter.js (107 lines) is imported only by server/tests/toolCalling.test.js and duplicates normalizeToolName/sanitizeSchemaForProvider from GenericToolCalling.js with an older, weaker sanitizer. In toolCalling, convertResponseFromGeneric is only ever called with target 'openai' (openaiProxy.js), so the reverse converters (convertGenericResponseTo{Anthropic,Google,Mistral,VLLM,VLLMNonStreaming}, processMessageFor{Anthropic,Google}) and the whole cross-provider layer (convertResponseBetweenProviders, convertToolsBetweenProviders, batchConvertResponses, createUnifiedInterface, createConverter, ToolCallPatterns, the error classes, getSupportedProviders, isProviderSupported, getProviderConverter, processMessageForProvider) have zero callers in server/, client/, or tests. Roughly 600+ lines of speculative API kept in sync for nothing.

**Evidence:** grep for each export name across server/ and client/ excluding adapters/toolCalling returns no hits (verified for all 14 names). toolFormatter.js only referenced from server/tests/toolCalling.test.js:8-11. openaiProxy.js:384-483 always passes 'openai' as target to convertResponseFromGeneric.

**Recommended fix:** Delete toolFormatter.js (port its test to GenericToolCalling exports). Delete the unused reverse converters and cross-provider helpers, keeping only convertToolsFromGeneric, convertResponseToGeneric, convertToolCallsFromGeneric, and the OpenAI-target response formatters used by openaiProxy.

<sub>Verifier: Verified: toolFormatter.js used only by tests (toolCalling.test.js:8-11,97-99). convertResponseFromGeneric always targets 'openai' (openaiProxy.js:384,400,426,483); dynamic dispatch (ToolCallingConverter.js:169) makes convertGenericResponseTo{Anthropic:336,Google:441,Mistral,VLLM} unreachable. Cross</sub>

---

## 🏛️ Architecture

### 113. Consolidate five parallel LLM invocation paths / two tool-calling loops

**Severity:** high · **Confidence:** 💡 design suggestion · **Effort:** large  
**Labels:** `architecture` `sev:high`

**Files:**
- `server/services/chat/ToolExecutor.js:1`
- `server/services/workflow/executors/PromptNodeExecutor.js:99`
- `server/services/workflow/executors/PromptNodeExecutor.js:1435`
- `server/services/workflow/WorkflowLLMHelper.js:1`
- `server/utils.js:501`
- `server/routes/openaiProxy.js:1`

**Problem:** The server has five independent LLM call paths: the chat pipeline (ChatService/RequestBuilder/StreamingHandler/ToolExecutor, ToolExecutor alone 1543 lines), the workflow engine's own multi-turn tool loop inside the 3491-line PromptNodeExecutor (~700 lines with its own circuit breaker and citation capture), WorkflowLLMHelper (638 lines: own SSE parsing, retry/backoff, adapter-option filtering), utils.simpleCompletion (own fetch/parse; used by magic prompt, translate, model test, agent tools), and openaiProxy (612 lines, own stream conversion). PromptNodeExecutor.js:99 constructs a ChatService that is never referenced again despite a docstring claiming integration. Retry, error classification, and token accounting differ per path.

**Evidence:** PromptNodeExecutor.js:99 'this.chatService = options.chatService || new ChatService();' is the only `this.chatService` occurrence in the file (grep). PromptNodeExecutor.js:11 comment 'This executor integrates with the existing ChatService and ToolExecutor' vs. its own loop at :1435 executeLLMWithTools / :1835 executeToolCall. WorkflowLLMHelper.js:8-11 documents it exists because 'AgentNodeExecutor was passing user and chatId options directly'. utils.js:543-556 hand-rolls createCompletionRequest + throttledFetch + convertResponseToGeneric again.

**Recommended fix:** Extract one LLM invocation service (request build, throttle, retry, SSE parse, tool loop, usage recording) consumed by chat, workflow executors, simpleCompletion and openaiProxy. Start by deleting the unused ChatService field and moving PromptNodeExecutor's tool loop onto ToolExecutor. This is the highest-leverage simplification in the repo.

---

### 114. Factor the copy-pasted admin CRUD 'quintuplet' handlers (models/apps/prompts/tools) into a resource-route factory

**Severity:** high · **Confidence:** 💡 design suggestion · **Effort:** large  
**Labels:** `architecture` `sev:high`

**Files:**
- `server/routes/admin/models.js:296`
- `server/routes/admin/prompts.js:779`
- `server/routes/admin/apps.js:812`
- `server/routes/admin/tools.js:742`
- `server/utils/toggleEnabled.js:13`

**Problem:** models.js, prompts.js, apps.js, tools.js (and largely sources.js) each reimplement the same list/get/create/update/toggle/batch-toggle/delete handlers with near-identical ~40-line bodies: validateIdForPath -> configCache.getX(true) -> find -> mutate -> fs.writeFile -> refreshXCache -> logAudit -> res.json. The single-toggle handlers in prompts.js:779, apps.js:812 and models.js:296 are line-for-line clones. Across ~5,500 lines behavior drifts silently: only apps handles renamed files (findAppFile), only models/apps write snapshots on delete, and these handlers use plain fs.writeFile instead of atomicWriteJSON, so a crash mid-write corrupts config. An abstraction for exactly this (server/utils/toggleEnabled.js) exists with zero importers.

**Evidence:** prompts.js:795-812 vs apps.js:826-851 vs models.js:310-341: identical toggle bodies (`const newEnabledState = !x.enabled; ... await fs.writeFile(filePath, JSON.stringify(x, null, 2)); await configCache.refreshXCache(); await logAudit({action:'toggle',...})`). Batch toggles models.js:347-400 duplicated per resource. Non-atomic writes: models.js:281/328/373, prompts.js:799, apps.js:838, tools.js:770 use fs.writeFile while 30+ other files use utils/atomicWrite.js. `grep -rn toggleEnabled server/` shows utils/toggleEnabled.js is never imported.

**Recommended fix:** Build one `registerAdminResource({name, dir, cacheRefresh, schema, hooks})` factory generating the seven endpoints with atomicWriteJSON, audit, and snapshot built in; keep resource-specific logic (default-model reassignment, findAppFile) as hooks. Delete toggleEnabled.js or make it the core of the factory.

---

### 115. ToolExecutor bypasses adapter stream parsing, breaking tool-enabled chat for non-SSE providers (Bedrock, iAssistant)

**Severity:** high · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:high`

**Files:**
- `server/services/chat/ToolExecutor.js:906`
- `server/services/chat/StreamingHandler.js:416`
- `server/adapters/bedrock.js:366`

**Problem:** StreamingHandler correctly delegates stream parsing to the provider adapter via adapter.parseResponseStream(llmResponse, ...) — Bedrock parses binary EventStream frames, iAssistant uses a line-delimited variant. ToolExecutor instead hand-rolls SSE parsing with createParser from eventsource-parser in both of its loops (lines 906 and 1306) and calls convertResponseToGeneric per event. For providers whose streams are not text/event-stream (Bedrock returns application/vnd.amazon.eventstream binary framing), the SSE parser produces no events, so any app with tools on such a model yields an empty response with no error. Stream-format knowledge is duplicated outside the adapters.

**Evidence:** ToolExecutor.js:906 `const parser = createParser({ onEvent: e => events.push(e) });` (again at 1306) vs StreamingHandler.js:411-416 `const adapter = getAdapter(model.provider); const stream = adapter.parseResponseStream(llmResponse, { model, chatId, request });`. bedrock.js:366 overrides parseResponseStream to decode BedrockEventStreamDecoder frames.

**Recommended fix:** Refactor ToolExecutor to consume `adapter.parseResponseStream()` like StreamingHandler does, so stream-format knowledge lives only in adapters. This can be done together with deduplicating the two loops.

---

### 116. Two divergent platform-config sources: raw boot snapshot vs resolved configCache — IHUB_* env overrides and admin saves half-apply

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/server.js:235`
- `server/middleware/setup.js:549`
- `server/middleware/authRequired.js:19`
- `server/configCache.js:186`

**Problem:** server.js loads platform.json raw (no env-var resolution, no IHUB_PLATFORM__* overrides) and feeds it to setupMiddleware, which freezes it into app.set('platform'), the auth-chain closure, body limits, sessions, and rate limiters; authRequired plus 10+ route files read this never-refreshed snapshot. Meanwhile configCache serves a resolved, override-applied, periodically refreshed copy used elsewhere (the CORS callback deliberately reads live config). Consequences: IHUB_PLATFORM__* overrides (auth mode, rate limits, requestBodyLimitMB) are silently ignored by boot-wired code; after an admin saves platform config, configCache readers flip immediately while authRequired keeps old values until restart — an inconsistent auth window.

**Evidence:** server.js:235 `platformConfig = await loadJson('config/platform.json');` → :428 `setupMiddleware(app, platformConfig)`. setup.js:549 `app.set('platform', platformConfig);` and :631-632 `const authConfig = platformConfig.auth || {}` (closure over boot snapshot). authRequired.js:19 `const platformConfig = req.app.get('platform') || {};` gates anonymous access. IHUB overrides applied only in configCache.setCacheEntry (configCache.js:186-189, 211-234). CORS reads live: setup.js:444 `const live = configCache.getPlatform() || platformConfig`.

**Recommended fix:** Make configCache the single source: initialize it before setupMiddleware and have app.get('platform')/middleware read configCache.getPlatform() per request (or update app settings in refreshCacheEntry). Document which settings are truly restart-only.

---

### 117. Oversized chat POST handler embeds workflow business logic inline

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/routes/chat/sessionRoutes.js:631`
- `server/routes/chat/sessionRoutes.js:697`

**Problem:** The POST /api/apps/:appId/chat/:chatId handler is ~300 lines mixing HTTP concerns with substantial business logic: @mention workflow detection/parsing, workflow enable/chatIntegration validation, chat-history reconstruction, dynamic import and fire-and-forget invocation of workflowRunner, plus a streaming/non-streaming branch that largely duplicates the same prepareChatRequest argument list twice (lines 801-822 and 867-888). This is hard to test and makes it easy for the two branches to diverge (an anonymous permission gap partly stems from logic living here instead of a service).

**Evidence:** chat/sessionRoutes.js:697-794 is the inline @mention workflow block. The prepareChatRequest call is duplicated with near-identical arg lists at lines 801-822 (non-streaming) and 867-888 (streaming), differing only in res vs clientRes/chatId.

**Recommended fix:** Extract @mention workflow detection into a service function, and build the prepareChatRequest argument object once, passing res/clientRes based on the streaming branch. Keep the handler thin (validate -> delegate -> respond).

---

### 118. Split the 2552-line workflowRoutes.js single-function module

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/routes/workflow/workflowRoutes.js:300`

**Problem:** `registerWorkflowRoutes` is a single ~2250-line function registering ~18 endpoints across five concerns: definition CRUD, execution lifecycle, SSE streaming, human-checkpoint handling, admin listing/toggle, and version publish/activate. The size makes ownership-check gaps (see IDOR finding) easy to miss and changes risky. The sibling agents router already demonstrates the smaller-module approach.

**Evidence:** File is 2553 lines; the exported function spans lines 300-2549. Distinct section banners already mark seams: 'Workflow Definition Endpoints' (322), 'Workflow Execution Endpoints' (768), 'SSE Streaming Endpoint' (1536), 'Human Checkpoint Response Endpoint' (1743), 'Admin Endpoints' (1965), 'Version Control Endpoints' (2218).

**Recommended fix:** Split into definitionRoutes.js, executionRoutes.js, streamRoutes.js, adminRoutes.js and versionRoutes.js under routes/workflow/, each registering its slice; keep index.js as the aggregator. Move the shared helpers (loadWorkflows, findWorkflowFile, filterByPermissions) into a workflowRouteHelpers.js.

---

### 119. PromptNodeExecutor (3491 lines) bundles ~8 unrelated responsibilities

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** large  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/services/workflow/executors/PromptNodeExecutor.js:924`
- `server/services/workflow/executors/PromptNodeExecutor.js:2389`
- `server/services/workflow/executors/PromptNodeExecutor.js:3059`

**Problem:** The largest file in the repo is a god-class mixing: (1) a full Handlebars-ish template engine (resolveTemplateVariables/processEachBlocks/getNestedValue, ~924-1218) that is generic and unrelated to prompting; (2) citation capture/format/redirect-resolution (3037-3488); (3) preview/truncation utilities (2899-3005); (4) a 490-line auto-persist state machine with six role branches (planner-task/synthesizer/memory-composer/reviewer/primary-producer) in _autoPersistResult (2389-2877); plus the tool loop, model resolution, and structured-output parsing. This makes the file unownable and untestable — the prime example of the owners' 'too much'.

**Evidence:** resolveTemplateVariables + processEachBlocks (924-1218) are provider-agnostic templating; _autoPersistResult (2389-2877) branches on _isPlannerTask/_isSynthesizer/_isMemoryComposer/_isReviewer/_persistAsArtifact; citation helpers (3037-3488) already have a sibling module citationUtils.js that only holds dedupeCitations.

**Recommended fix:** Extract a templateEngine module, move all citation capture/format into citationUtils.js, move preview/truncation helpers to a shared util, and split the auto-persist role branches into small per-role strategies. Target well under 1000 lines for the executor.

---

### 120. Multiple WorkflowEngine instances; workflowRunner constructs a new one per chat call

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/tools/workflowRunner.js:240`
- `server/routes/workflow/workflowRoutes.js:301`
- `server/routes/agents/runs.js:37`
- `server/routes/agents/artifacts.js:25`

**Problem:** At least five independent WorkflowEngine instances exist (workflowRoutes module-level, agents/runs lazy singleton, agents/artifacts lazy singleton, server-boot resume engine, and workflowRunner, which does `new WorkflowEngine()` on EVERY chat invocation). StateManager is correctly a shared singleton, but `abortControllers` is per-instance: a cancel routed through a different engine instance than the one running the loop can only flip the persisted status (picked up between nodes) — it cannot fire that run's abort signal. Every chat-driven workflow also gets a throwaway engine whose only unique state is its abort map.

**Evidence:** workflowRunner.js:240 `const engine = new WorkflowEngine();` per call, stored in activeWorkflowExecutions for cancel; workflowRoutes.js:301 `deps.workflowEngine || new WorkflowEngine()`; agents/runs.js:37 and agents/artifacts.js:25 each build their own getEngine() singleton. abortControllers is instance state (WorkflowEngine.js:100).

**Recommended fix:** Introduce a `getWorkflowEngine()` singleton (mirroring getStateManager) and have all routes/tools share it, so abort controllers and cancellation are coherent across entry points.

---

### 121. Decide kill-or-commit for ~40k lines behind default-off preview feature flags

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** large  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/featureRegistry.js:11`
- `server/services/workflow`
- `server/agents`
- `server/routes/toolsService`
- `server/services/marketplace`
- `client/src/features/workflows`

**Problem:** Six of fourteen registered features are `category: 'preview', default: false`: skills, workflows, marketplace, toolsService, agentFactory, appAsTool. The gated code is enormous: server/services/workflow 19,369 lines + routes/{workflow,agents} 3,912 + server/agents 2,224 + client workflows feature 8,189 + client agent admin pages 4,455 + marketplace ~1,755 + toolsService 1,257 (including an 808-line OCR processor) — roughly 40k lines, plus dedicated migrations (V047, V052-V054, V065), shipped to every customer switched off. Each preview feature carries admin pages, validators, and docs that must be maintained regardless of adoption.

**Evidence:** server/featureRegistry.js:12-158 — skills/workflows/marketplace/toolsService/agentFactory/appAsTool all `default: false, preview: true`. Line counts measured: `find server/services/workflow -name '*.js' | xargs wc -l` = 19,369; client/src/features/workflows = 8,189; agent admin pages = 4,455; server/routes/toolsService = 1,257; server/services/marketplace = 1,755.

**Recommended fix:** Per flag, decide ship (promote to default-on, finish docs) or cut (delete, keep in a branch). Prime cut candidates: toolsService OCR (single processor, preview since inception) and appAsTool if agentFactory isn't the roadmap bet. Workflows+agents should merge their run-wiring (see separate finding) if kept.

---

### 122. Extract agent-run wiring duplicated between server.js bootstrap and agents routes; tame the 952-line prompt-wall serializer

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `server/server.js:620`
- `server/routes/agents/runs.js:33`
- `server/agents/profile/profileWorkflowSerializer.js:41`

**Problem:** Agent-run construction is duplicated: server.js's boot-time resume path (lines 620-681) re-imports serializeProfile, applyNodeModels, applyReviewSettings — the latter two exported from the ROUTE module routes/agents/runs.js — and re-creates a WorkflowEngine with the same magic 30-minute timeout, with a comment admitting the copy. Any change to run wiring must be made in both places or resumed runs behave differently from fresh ones. profileWorkflowSerializer.js is 952 lines, ~40% hardcoded English prompt walls (DEFAULT_PLANNER_SYSTEM lines 41-86, DEFAULT_SYNTHESIZER_SYSTEM 99+), whose churn required migrations V052/V053/V054 to rebuild definitions already generated onto customer disks.

**Evidence:** server.js:622 'const { applyNodeModels, applyReviewSettings } = await import("./routes/agents/runs.js")'; server.js:625-628 '30-minute default node timeout consistent with the agent-run engine in routes/agents/runs.js' vs runs.js:37 'new WorkflowEngine({ defaultTimeout: 30 * 60 * 1000 })'. profileWorkflowSerializer.js:9-16 narrates the redesign: 'every fix added more defensive language to the prompts'. Migrations V052 (rebuild embedded agent workflows), V053, V054.

**Recommended fix:** Move buildAgentRun(profile, options) — serialize, clone, applyNodeModels, applyReviewSettings, budget config, engine defaults — into server/agents/runtime/, consumed by both runs.js and the resume path. Move default planner/synthesizer prompts into editable default config files so future tuning is a content change, not a code+migration change.

---

### 123. Move ~700 lines of export/PDF template code out of api/endpoints/apps.js; delete its duplicated markdown helpers

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/api/endpoints/apps.js:243`
- `client/src/api/endpoints/apps.js:712`
- `client/src/api/endpoints/apps.js:743`
- `client/src/utils/markdownUtils.js:38`

**Problem:** endpoints/apps.js is 914 lines, but only ~130 are API calls; the rest is PDF HTML generation, three CSS templates, watermark styling, and download/export helpers. It privately re-implements isMarkdown, htmlToMarkdown, markdownToHtml, and cleanHtmlForExport, which already exist in utils/markdownUtils.js with better turndown/marked-based semantics — the regex htmlToMarkdown silently loses links, lists, and headings. cleanHtmlForExport is a byte-identical dead copy (zero call sites). A third export module, utils/exportFormats.js (1197 lines), has its own hand-rolled markdown parser — three markdown-handling implementations for one export feature.

**Evidence:** apps.js:712-766 defines local `isMarkdown`, `htmlToMarkdown`, `markdownToHtml`, `cleanHtmlForExport`; grep shows only `isMarkdown`/`htmlToMarkdown` used (line 772), `markdownToHtml` and `cleanHtmlForExport` are dead. markdownUtils.js:38-44 `htmlToMarkdown = html => turndownService.turndown(html)` vs apps.js:718-730 regex version. apps.js:243-671 is generatePDFHTML + getTemplateStyles + getWatermarkStyle (CSS strings).

**Recommended fix:** Move exportChatTo*/generatePDFHTML into a chat-export feature module (colocated with exportFormats.js), delete the dead markdownToHtml/cleanHtmlForExport copies, and use utils/markdownUtils.js for the surviving helpers. Keeps api/endpoints/* as thin HTTP wrappers.

---

### 124. Move AgentRunDetailPage's ~500 lines of run-timeline derivation into a tested pure module

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AgentRunDetailPage.jsx:168`
- `client/src/features/admin/utils/tokenStats.js`

**Problem:** AgentRunDetailPage (1539 lines) computes the entire run timeline inline in the component body on every render: dual event-shape normalization (SSE `event:` vs persisted `type:`, lines 168-204), task status maps, orchestrator-node detection heuristics hardcoded to server internals ('planner', 'synthesize', 'review-loop', '_stepLogs', '_taskResults', '_nodeIterations', '_persistAsArtifact'), recovered-task backfill, and unifiedTasks assembly (lines 370+). Dense comments documenting prior wrong approaches show this logic is fragile and repeatedly iterated on — yet it has zero tests and re-runs wholesale on every SSE tick. tokenStats.js (with tests) already demonstrates the right pattern in the same feature.

**Evidence:** AgentRunDetailPage.jsx:168-181 NODE_START_KEYS/eventKind normalization; :182-204 taskStatusByNodeId IIFE; :245-370 hasPlanner/hasReviewer/hasMemoryCompose heuristics; :370-540 unifiedTasks construction — all inside the component render body. Comments like 'Previously this row appeared the moment...' (line ~270) document repeated breakage.

**Recommended fix:** Extract deriveRunTimeline(run) into features/admin/utils/ as a pure function returning unifiedTasks + statuses, unit-test it against fixture run states (live SSE and persisted shapes), and memoize the call in the component.

---

### 125. Split the 2545-line AppFormEditor into section components with a shared nested-update helper

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** large  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/features/admin/components/AppFormEditor.jsx:36`
- `client/src/features/admin/components/PlatformFormEditor.jsx:70`

**Problem:** AppFormEditor is a single 2545-line component: one giant return with 15+ config sections (basic info, system, iframe/redirect, variables, starter prompts, websearch, iassistant, tools, MCP, workflows, skills, upload x3, input mode, greeting) and a dozen hand-written immutable-update handlers repeating the same map/spread pattern. PlatformFormEditor (1840 lines) repeats the same shape with its own add/update/remove triplets per provider type (OIDC/JWT/LDAP, lines 136-275) and mostly untranslated hardcoded strings. Any change requires scrolling a 2.5k-line file; the same handler bug must be fixed N times.

**Evidence:** AppFormEditor.jsx:150-236 four near-identical nested-array handlers; :1239-1330 tools/MCP sections; :1629-1930 three parallel upload sub-forms. PlatformFormEditor.jsx:136-275 three add/update/remove provider triplets differing only in config key.

**Recommended fix:** Extract each card into components/app-form/ section files receiving (app, onChange), plus a tiny updateIn(obj, path, value) helper (or use the existing DynamicLanguageEditor pattern) to kill the repeated spread pyramids. Do the same provider-list extraction for PlatformFormEditor.

---

### 126. shared/ modules import from features/ — layering inversion bakes office/admin specifics into shared code

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/shared/hooks/useEventSource.js:4`
- `client/src/shared/hooks/useEventSource.js:102`
- `client/src/shared/components/DynamicLanguageEditor.jsx:5`

**Problem:** The documented architecture is features depend on shared, not the reverse. Two shared modules violate this: useEventSource.js (the app-wide chat SSE hook) imports getRefreshToken/refreshTokenOrExpireSession from features/office/api/officeAuth and hardcodes the Office add-in token key 'office_ihubtoken' into its auth-header logic, so the core chat streaming path silently depends on the Office feature's token lifecycle. DynamicLanguageEditor.jsx (used in 17 places) imports useFormValidationErrors from features/admin/components/formValidationContext. This makes features impossible to remove/lazy-load independently.

**Evidence:** useEventSource.js:4: `import { getRefreshToken, refreshTokenOrExpireSession } from '../../features/office/api/officeAuth';` and :101-103: `const token = localStorage.getItem('office_ihubtoken') || localStorage.getItem('authToken')`. DynamicLanguageEditor.jsx:5: `import { useFormValidationErrors } from '../../features/admin/components/formValidationContext';`.

**Recommended fix:** Invert the dependencies: let useEventSource accept an optional getAuthHeaders/onUnauthorized callback that the Office adapter supplies, and move formValidationContext into shared/ (or pass validationErrors as a prop, which the component already supports).

---

### 127. Two competing global `marked` configurations cause per-page rendering workarounds

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/utils/markdownUtils.js:7`
- `client/src/config/marked.config.js:30`
- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx:242`

**Problem:** The client mutates the single global `marked` instance from two independent places: markdownUtils.js calls marked.setOptions({breaks, gfm, sanitize:false}) at module import time, while config/marked.config.js's configureMarked(t) installs a custom renderer (code blocks, mermaid) and is re-invoked by at least 7 components (ChatMessage, StreamingMarkdown, MarkdownViewer, UnifiedPage, ArtifactViewer, markdownExports, WorkflowExecutionPage). Which options are active depends on import order and which page ran last — the exact bug class documented in WorkflowExecutionPage's comment. Sanitization is also decided per call site rather than centrally, leaving unsanitized render paths.

**Evidence:** markdownUtils.js:7-11: module-level `marked.setOptions({... sanitize: false })`. marked.config.js:30: `export const configureMarked = t => { const renderer = new marked.Renderer(); ... }` mutating the same singleton. WorkflowExecutionPage.jsx:242-248: 'Install the same code-block renderer the chat uses. Without this, fenced code blocks ... get marked's default <pre><code> ... (chat configures its renderer on mount)'.

**Recommended fix:** Create one shared markdown module exposing renderMarkdown(text, opts) that owns a dedicated Marked instance (marked supports instantiation), applies the renderer once, and always sanitizes. Delete the module-level setOptions in markdownUtils and the per-component configureMarked effects.

---

### 128. PlatformConfigContext duplicates auth and UI state owned by AuthContext/UIConfigContext

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `client/src/shared/contexts/PlatformConfigContext.jsx:23`
- `client/src/shared/contexts/AuthContext.jsx:103`
- `client/src/features/apps/components/AppProviders.jsx:35`

**Problem:** Three contexts fetch and hold overlapping server state. PlatformConfigProvider fetches /auth/status + /configs/ui + /configs/platform and stores auth fields (authenticated, user, authMethods) and UI fields inside `platformConfig`; AuthContext independently fetches '/auth/status' via a direct apiClient.get (bypassing the cached/deduped fetchAuthStatus endpoint — a second network request on boot); UIConfigProvider fetches /configs/ui again. The result is two sources of truth for the current user and for auth methods, and consumers like UserAuthMenu already hedge between them.

**Evidence:** PlatformConfigContext.jsx:23-27: `const [authStatus, uiConfig, platformCfg] = await Promise.all([fetchAuthStatus(...), fetchUIConfig(...), fetchPlatformConfig(...)])` then lines 65-67 store `authenticated: authStatus.authenticated, user: authStatus.user`. AuthContext.jsx:103: `await apiClient.get('/auth/status', ...)` (uncached, separate request). UserAuthMenu.jsx:47-48: `authConfig?.anonymousAuth?.enabled ?? platformConfig?.anonymousAuth?.enabled !== false`.

**Recommended fix:** Make AuthContext the single owner of /auth/status (using the cached fetchAuthStatus endpoint) and have PlatformConfigContext expose only platform features; drop user/authenticated/authMethods from platformConfig and remove the redundant fetchUIConfig in one of the two providers.

---

### 129. Prune 6.2 MB / 368-file concepts/ archive of completed design docs

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `architecture` `sev:medium`

**Files:**
- `concepts/`
- `AGENTS.md:14`

**Problem:** concepts/ contains 368 files (6.2 MB, 279 top-level entries) — more files than docs/ (105 md files). Much of it is finished-work status logging rather than living design docs: seven '2025-07-28 Refactoring ...' files including 'Refactoring Completed.md', '...Testing Summary' docs, 'IMPLEMENTATION_SUMMARY' files, and one-off fix write-ups ('2026-01-19 Strict Mode Fix.md', '2025-12-04 EPUB Build Fix.md'). AGENTS.md points agents at concepts/, so every stale/contradictory concept doc is candidate context for coding agents — 'tried until we found the solution' residue checked into main.

**Evidence:** `find concepts -type f | wc -l` → 368; `du -sh concepts` → 6.2M. File list includes concepts/2025-07-28 Refactoring Completed.md, concepts/2025-07-28 Refactoring Final steps.md, concepts/2025-11-14 App Types Testing Summary.md, concepts/2026-01-19 Strict Mode Fix.md. AGENTS.md:14 'Concepts: Concepts for each feature are located in concepts'.

**Recommended fix:** Move completed/implementation-summary/fix-log docs to an archive (separate branch, wiki, or concepts/archive/ excluded from agent instructions); keep only active design docs. Add a policy that shipped features graduate from concepts/ to docs/.

---

### 130. Two different route modules both export registerSessionRoutes

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `architecture` `sev:low`

**Files:**
- `server/routes/sessionRoutes.js:10`
- `server/routes/chat/sessionRoutes.js:31`
- `server/routes/chat/index.js:1`

**Problem:** There are two files named sessionRoutes.js exporting a default registerSessionRoutes with unrelated responsibilities: routes/sessionRoutes.js registers only POST /api/session/start (44 lines), while routes/chat/sessionRoutes.js registers the chat SSE/POST/stop/status endpoints (1100+ lines). Both are registered in server.js (the top-level one directly, the chat one via registerChatRoutes). The identical name and filename is a maintenance trap — grep/imports are ambiguous and it's easy to edit or import the wrong one.

**Evidence:** server.js:23 `import registerSessionRoutes from './routes/sessionRoutes.js'` and chat/index.js:1 `import registerSessionRoutes from './sessionRoutes.js'`. Both default-export a function of the same name.

**Recommended fix:** Rename the top-level module to registerAppSessionStartRoute (file appSessionRoutes.js) or fold POST /api/session/start into the chat/session module, so there is one clearly-named session route registrar.

---

### 131. getAdapter silently falls back to the OpenAI adapter for unknown providers

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `architecture` `sev:low`

**Files:**
- `server/adapters/index.js:29`
- `server/adapters/toolCalling/ToolCallingConverter.js:143`

**Problem:** getAdapter returns the OpenAI adapter for any unrecognized provider string, so a typo'd or unregistered provider sends OpenAI-shaped requests to an arbitrary URL and fails deep in streaming with confusing parse errors instead of a clear configuration error at request-build time. Meanwhile the converter registry (CONVERTERS in ToolCallingConverter.js) throws 'Unsupported provider' for the same input, so the two layers disagree: a bad provider can build a request via the OpenAI fallback and then blow up mid-stream in convertResponseToGeneric. Inconsistent failure modes make provider misconfiguration hard to diagnose.

**Evidence:** index.js:29 `const adapter = adapters[provider] || adapters['openai']; // Fallback to OpenAI`. ToolCallingConverter.js:143-146 `const converter = CONVERTERS[sourceProvider]; if (!converter) { throw new Error(`Unsupported provider for response conversion: ${sourceProvider}`); }`.

**Recommended fix:** Make getAdapter throw (or log an explicit error) for unknown providers; model configs are already validated against a provider enum in modelConfigSchema.js, so the silent fallback protects nothing legitimate.

---

### 132. actionTracker: process-global step counter reports wrong per-chat step numbers; single emitter accumulates per-request listeners

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `architecture` `sev:low`

**Files:**
- `server/actionTracker.js:6`
- `server/services/chat/streamSink/InMemorySink.js:140`
- `server/routes/agents/runs.js:607`
- `server/routes/workflow/workflowRoutes.js:1697`

**Problem:** ActionTracker.trackAction increments a single `this.steps` counter on the process-wide singleton and emits it per chat, so with concurrent chats every chat sees a shared, monotonically growing 'steps' value rather than its own count (and it never resets). Separately, the singleton EventEmitter is a global bus: each InMemorySink instance, agent-run SSE connection, workflow SSE connection, and workflowRunner bridge attaches its own 'fire-sse' listener filtering by chatId. Above 10 concurrent attachments Node emits MaxListenersExceededWarning (no setMaxListeners exists), and every event fans out to every listener, O(listeners x events).

**Evidence:** actionTracker.js:6-13: `constructor() { super(); this.steps = 0; } trackAction(chatId, action = {}) { this.steps += 1; this.emit('fire-sse', { event: 'action', steps: this.steps, chatId, ...action }); }`. Listener attachments: InMemorySink.js:140, sse.js:11, tools/workflowRunner.js:553, routes/agents/runs.js:607, routes/workflow/workflowRoutes.js:1697. `grep -rn setMaxListeners server/` → no matches.

**Recommended fix:** Track steps per chatId (e.g. Map<chatId, count>, cleaned on session end). For the bus, either raise maxListeners deliberately or route per-chat subscribers through a keyed Map (as sse.js already does) instead of one listener per request.

---

### 133. Migration V052 imports live application code, breaking migration immutability guarantees

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `architecture` `sev:low`

**Files:**
- `server/migrations/V052__rebuild_embedded_agent_workflows.js:39`

**Problem:** V052 imports serializeProfile from server/agents/profile/profileWorkflowSerializer.js and regenerates on-disk workflow definitions with it. The migration system's contract is that a versioned migration produces the same result whenever it runs (checksums guard the file), but here the outcome depends on whatever the serializer does when the migration happens to run — an install migrating today gets a different rebuild than one migrated at release time, and future serializer refactors can silently change this 'immutable' migration. V024 also shows the folder's copy-paste hazard: its header says 'Migration V023' while exporting version '024' (same in V063).

**Evidence:** V052__rebuild_embedded_agent_workflows.js:39 `import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';` and :144 `const rebuiltProfile = serializeProfile(profile);`. V024__rename_model_files_to_match_ids.js:2 header `Migration V023` vs :14 `export const version = '024'`.

**Recommended fix:** Establish a rule (README in server/migrations/) that migrations must be self-contained — inline or snapshot any transformation logic they need — and fix the mismatched header comments while touching the files.

---

## ✂️ Simplification

### 134. configCache: triplicated per-type load logic, inconsistent return shapes, and dead/broken getWithFallback

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `simplification` `sev:medium`

**Files:**
- `server/configCache.js:327`
- `server/configCache.js:579`
- `server/configCache.js:1192`
- `server/configCache.js:785`
- `server/configCache.js:853`

**Problem:** The 1715-line configCache implements the same per-type special-casing three times: initialize() (327-460), refreshCacheEntry() (579-751), and seven refreshXCache() methods (1192-1340) — ~350 lines of drift-prone duplication (refreshModelsCache skips the ETag comparison refreshCacheEntry does; credentials decryption lives in two places). Getter return shapes are inconsistent: getApps/getTools/getPrompts return a bare [] on cache miss but {data, etag} otherwise, forcing defensive `|| {}` at call sites (requestThrottler.js:22-23). getWithFallback (785-802) is both dead (zero callers) and broken — get() never returns null, so the file fallback is unreachable.

**Evidence:** Nine special-case if-blocks duplicated between initialize (configCache.js:330-455) and refreshCacheEntry (:584-731); refreshAppsCache :1234-1249 duplicates the apps branch again without the ETag check. getApps miss path :853-854 `return [];` vs hit path :861-864 `return { data..., etag... }`. getWithFallback :786-789 `const cached = this.get(configPath); if (cached !== null) { return cached; }` with get() :758-763 always returning an object.

**Recommended fix:** Introduce a declarative loader registry ({key, load(includeDisabled), postProcess}) consumed by initialize, refreshCacheEntry and a single generic refresh(key); normalize all getters to {data, etag}; delete getWithFallback.

---

### 135. Replace the fetch-over-axios shim in makeAdminApiCall; callers use three different body conventions

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `simplification` `sev:medium`

**Files:**
- `client/src/api/adminApi.js:22`
- `client/src/api/adminApi.js:59`
- `client/src/features/admin/components/JiraConfig.jsx:80`

**Problem:** makeAdminApiCall emulates the fetch API on top of axios: string bodies are JSON.parse'd back into objects (adminApi.js:30-33), object bodies pass through, and axios-style `data:` also works because options are spread into the config — so callers use all three conventions (AdminAppEditPage stringifies, AdminAppsPage passes objects, JiraConfig.jsx:80-83 passes `data:`). For FormData it abandons axios entirely, re-implementing base-URL resolution, session-ID injection, error shaping, and the 401 authTokenExpired dispatch with raw fetch (:59-96, :99-130). A non-JSON string body throws in JSON.parse before any request is made; the inconsistency spreads through 100+ admin call sites.

**Evidence:** adminApi.js:31 `axiosConfig.data = JSON.parse(options.body);`; :59 comment 'For FormData requests, use fetch directly to avoid axios default headers' followed by duplicated auth/session/error handling; the long comment at :104-125 explains why the 401 dispatch is duplicated across both paths.

**Recommended fix:** Make makeAdminApiCall accept a single convention (plain object body) and pass FormData through axios (deleting the Content-Type header is enough for axios to set the multipart boundary). Codemod callers to stop pre-stringifying.

---

### 136. AppChat.handleSubmit hand-builds message HTML with duplicated inline styles and repeated file-classification IIFEs

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `simplification` `sev:medium`

**Files:**
- `client/src/features/apps/pages/AppChat.jsx:1320`
- `client/src/features/apps/pages/AppChat.jsx:1445`

**Problem:** handleSubmit contains two parallel content-building branches (single-file vs array) that emit the same hardcoded inline-styled HTML badges for images/audio/documents, followed by three near-identical IIFEs that re-scan selectedFile to classify image/audio/document data. This is ~170 lines of copy-paste logic inside an already 1983-line component, and the badge markup is duplicated again for the single-file path (1371-1381).

**Evidence:** AppChat.jsx:1330-1382 builds `<div style="display: inline-flex; ...">` badges in both the multi-file (1341-1360) and single-file (1375-1379) paths; lines 1445-1486 repeat the same Array.isArray(selectedFile) ? filter(type===X) : ... pattern three times for imageData/audioData/fileData.

**Recommended fix:** Extract a buildMessageFromFiles(selectedFile, text, t) helper returning { messageContent, messageData, imageData, audioData, fileData }; reuse it and move badge markup to a small template function.

---

### 137. ChatService is a pass-through facade of re-destructured params; its non-streaming branch drops error-localization params

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `server/services/chat/ChatService.js:21`
- `server/services/chat/ChatService.js:186`

**Problem:** prepareChatRequest, processNonStreamingChat, processStreamingChat, and processChatWithTools (ChatService.js:21-137) each destructure ~10-20 named params only to re-pass the identical object to the underlying handler — ~115 lines of pure boilerplate where every new parameter must be threaded through 2-3 places (this is how `variables` got dropped, see separate finding). It already caused a second bug: processChat's non-streaming branch (186-195) omits `getLocalizedError` and `clientLanguage`, so NonStreamingHandler.createEnhancedLLMApiError runs with clientLanguage undefined and provider errors are never localized on the non-streaming path.

**Evidence:** ChatService.js:46-69 re-lists 20 params verbatim; 186-195 `return await this.processNonStreamingChat({ request, res, buildLogData, messageId, model, llmMessages, DEFAULT_TIMEOUT });` — missing getLocalizedError/clientLanguage that NonStreamingHandler.js:21-22 declares and uses at line 100.

**Recommended fix:** Forward the params object directly (`this.requestBuilder.prepareChatRequest({ ...params, processMessageTemplates })`) or drop the facade methods and call handlers directly; fix the non-streaming call to pass clientLanguage.

---

### 138. _executeWithTimeout uses the async-Promise-executor anti-pattern and leaks the operation on timeout

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `server/services/workflow/WorkflowEngine.js:1554`

**Problem:** `_executeWithTimeout` wraps an `async (resolve, reject) => {...}` inside `new Promise`, which is a known anti-pattern (a synchronous throw before the first await is swallowed rather than rejecting). More importantly, on timeout it rejects but leaves `fn()` running with no cancellation, so the timed-out node's LLM/tool work continues in the background (see the cancellation finding).

**Evidence:** WorkflowEngine.js:1555 `return new Promise(async (resolve, reject) => { const timeoutId = setTimeout(() => { ...reject(error) }, timeout); try { const result = await fn(); ...`.

**Recommended fix:** Rewrite with Promise.race over a rejecting timer plus an AbortController that is signaled on timeout and passed into fn(), eliminating the async executor and actually tearing down the timed-out work.

---

### 139. usageTracker: recordChatRequest/recordChatResponse are near-identical 40-line duplicates and rating math is triplicated

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `server/usageTracker.js:230`
- `server/usageTracker.js:312`

**Problem:** recordChatRequest (230-269) and recordChatResponse (271-310) differ only in which token bucket (prompt vs completion) and event type they write — everything else (config load, user resolution, message counters, per-user/app/model increments, tokenSources, telemetry, logUsageEvent, dirty/save) is duplicated line for line. The 1-5-star rating aggregation (round to 0.5, ceil, weighted average, legacy good/bad mapping) is implemented twice more: inline in recordFeedback (319-350) and again in incFeedback (195-223), plus a third variant in migrateLegacyFeedback. Any change to rating semantics must be made in three places.

**Evidence:** usageTracker.js:243-257 vs 284-298 are identical except `data.tokens.prompt.*` vs `data.tokens.completion.*`; both repeat `if (!data.tokenSources) data.tokenSources = { provider: 0, estimate: 0 };`. Rating math duplicated: 196-218 (incFeedback) and 320-345 (recordFeedback) both contain `Math.round(rating * 2) / 2`, `Math.ceil`, the same weightedSum reduce, and the same `ratingKey >= 4 ? good : bad` legacy mapping.

**Recommended fix:** Collapse to one `recordChatMessage({direction})` helper and one `applyRating(bucket, rating)` used by both recordFeedback and incFeedback. Consider whether the legacy good/bad fields can be dropped via a one-time data migration.

---

### 140. AgentRunsPage polls every 5s unconditionally (comment claims adaptive cadence) and duplicates run-list helpers from AdminWorkflowExecutionsPage

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `client/src/features/admin/pages/AgentRunsPage.jsx:49`
- `client/src/features/admin/pages/AdminWorkflowExecutionsPage.jsx:32`

**Problem:** AgentRunsPage sets `interval = setInterval(load, 5000)` with the comment 'Refresh while any run is in flight; otherwise drop to a slower cadence' — but no slower cadence exists; the page hammers /admin/agents/runs every 5s forever while open, even when all runs are terminal. The page also re-implements status badges, timestamp formatting, and polling that AdminWorkflowExecutionsPage (648 lines) implements separately with its own getStatusBadgeClasses/computeDuration — two divergent copies of the same run-monitoring UI (agent runs are workflow executions underneath, sharing status vocabulary).

**Evidence:** AgentRunsPage.jsx:49-51 comment vs unconditional setInterval; STATUS_BADGE_CLASSES map at :12-17 duplicates AdminWorkflowExecutionsPage.jsx:32-57 getStatusBadgeClasses.

**Recommended fix:** Honor the comment: poll at 5s only while `runs.some(r => r.status === 'running' || r.status === 'paused')`, else 30s or stop. Extract shared StatusBadge/duration/poll helpers used by both pages (and AgentRunDetailPage).

---

### 141. Verbose emoji debug logging shipped to production across chat hooks/components

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `client/src/features/chat/hooks/useChatMessages.js:26`
- `client/src/features/apps/pages/AppChat.jsx:367`
- `client/src/features/chat/hooks/useAppChat.js:159`

**Problem:** The core chat path logs on every message load/save/update and on every send/complete/redirect decision, including dumping message arrays and content lengths. useChatMessages logs raw sessionStorage contents (potential PII) plus per-update image summaries; AppChat logs param objects and canvas-redirect decisions. This is console noise, a minor perf cost on large histories, and leaks message data to the browser console.

**Evidence:** useChatMessages.js:26-53 (Raw sessionStorage data / Loading messages), 152-164 (Saving), 279 (Image update); AppChat.jsx:367-383 & 402-414 (shouldAutoRedirectToCanvas / handleMessageComplete), 1404 (Sending message with params); useAppChat.js:159/316/583 clarification logs. 8 console.log in useChatMessages, 8 in AppChat.

**Recommended fix:** Remove or gate these behind a debug flag (e.g. import.meta.env.DEV) — especially the sessionStorage dumps.

---

### 142. ExecutionProgress renders the same item row twice (~90 duplicated JSX lines)

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `simplification` `sev:low`

**Files:**
- `client/src/features/workflows/components/ExecutionProgress.jsx:604`
- `client/src/features/workflows/components/ExecutionProgress.jsx:694`

**Problem:** In the 846-line ExecutionProgress component, the grouped-iterations branch (lines 604-687) and the single-occurrence branch (lines 694-771) render the identical row: NodeStatus icon, model badge, tokens badge, duration formatting, timestamp, insight line, truncated outputValue preview, expand chevron, and ItemDetails panel. Any change to row rendering (e.g. the duration formatting ternary that appears verbatim at 645-653 and 732-739) must be made twice; the token-badge block is also duplicated character-for-character (634-644 vs 722-731).

**Evidence:** Lines 645-652 and 732-739 both contain `{item.duration >= 1000 ? `${(item.duration / 1000).toFixed(1)}s` : item.duration > 0 ? `${item.duration}ms` : '<1ms'}`; lines 634-644 and 722-731 both contain the identical showTechnical tokens span with the same title template.

**Recommended fix:** Extract an `<ItemRow item ... />` component used by both branches (grouped rows pass an extra iteration badge prop). This roughly halves the component and removes the double-maintenance hazard.

---

### 143. IntegrationsPage duplicates the integration card block per provider and is entirely non-localized

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `simplification` `sev:low`

**Files:**
- `client/src/features/settings/pages/IntegrationsPage.jsx:350`
- `client/src/features/settings/pages/IntegrationsPage.jsx:469`
- `client/src/features/settings/pages/IntegrationsPage.jsx:174`

**Problem:** The JIRA card (lines 350-466) and the cloud-provider card (469-586) are near-identical ~115-line JSX blocks (icon tile, connected pill, userInfo panel, connect/disconnect buttons, 'Available Features' checklist), and handleDisconnect (174-202) vs handleCloudDisconnect (205-234) are the same function with a different URL. Adding the next integration type means a third copy. The page also hardcodes every user-facing string in English ('Connected', 'Disconnect', 'Authentication Required', 'More Integrations Coming Soon') in an app otherwise fully i18n'd via react-i18next — it imports useTranslation but only uses i18n.language.

**Evidence:** Compare lines 370-380 with 494-504 (identical connected-pill markup), 397-424 with 531-549 (identical button rows), and handleDisconnect vs handleCloudDisconnect bodies (177 `fetch('/api/integrations/jira/disconnect'...` vs 207 `fetch(`/api/integrations/${provider.type}/disconnect`...`). Line 11: `const { i18n } = useTranslation();` — `t` is never destructured; all strings are literals.

**Recommended fix:** Extract one IntegrationCard component driven by a config object (id, icon, description, features, endpoints) and a single connect/disconnect/status handler parameterized by integration type; wrap all strings in t(). Combine with the buildApiUrl fix from the hardcoded-/api finding.

---

## ⚙️ Configuration & Build

### 144. docker-compose.prod.yml is stale and incompatible with the current server (read-only config + host contents mounts)

**Severity:** high · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `config` `sev:high`

**Files:**
- `docker/docker-compose.prod.yml:11`
- `docker/docker-compose.prod.yml:68`
- `docker/docker-compose.prod.yml:85`
- `docker/DOCKER.md`

**Problem:** The production compose file (`npm run docker:prod:up`, documented in CLAUDE.md/DOCKER.md) cannot work with today's server: (1) its init container copies from `../contents/config` etc. on the host, but `contents/` does not exist in a fresh clone (generated at first boot from server/defaults), so volumes seed empty; (2) it mounts `/app/contents/config` read-only while the migration system writes config/platform.json — migrations fail with EROFS (default onFailure 'halt') and admin config saves break; (3) `.migration-history.json` and `.encryption-key` live at /app/contents root, which is not a volume, so migration history and the secret-encryption key are lost on container recreation.

**Evidence:** docker-compose.prod.yml:11 `- ../contents/config:/source-config:ro` (repo has no contents/ — `ls /home/user/ihub-apps` confirms); :14 `- ../contents/locales:/source-locales:ro`; :68-72 `- ihub-config:/app/contents/config:ro` ('read-only for security'); migrations write via ctx.writeJson('config/platform.json', ...) (runner.js:161-163); TokenStorageService stores contents/.encryption-key per CLAUDE.md; :85 `WORKERS=${WORKERS:-4}` amplifies the concurrent-migration race.

**Recommended fix:** Rewrite docker-compose.prod.yml around a single writable contents volume (like docker-compose.quickstart.yml), delete the init container (performInitialSetup already seeds defaults), or delete the file entirely and point docs at the quickstart compose.

<sub>Verifier: Verified: contents/ is gitignored, 0 tracked files (.gitignore:1), so init-container bind mounts (docker-compose.prod.yml:11-15) seed empty; defaults moved to server/defaults. Config mounted :ro (:68-72) while migrations write config/platform.json (runner.js:161, V035:35) with onFailure 'halt' (runn</sub>

---

### 145. PDF.js worker loaded from hardcoded public CDN breaks offline/air-gapped deployments

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `client/src/features/upload/utils/fileProcessing.js:142`

**Problem:** loadPdfjs sets GlobalWorkerOptions.workerSrc to a cdnjs.cloudflare.com URL. The platform explicitly targets privacy-focused, offline/enterprise deployments (local LLMs, LDAP/NTLM/OIDC). In an air-gapped or CDN-blocked environment, every PDF upload silently fails to parse. The version is also pinned to 4.10.38 by hand and must be kept in lockstep with the pdfjs-dist dependency (^4.10.38) or the worker/API mismatch breaks.

**Evidence:** fileProcessing.js:142-143 `pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';`. package.json declares pdfjs-dist ^4.10.38.

**Recommended fix:** Import the worker from the installed package (e.g. `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`) so Vite bundles it locally and versions stay in sync.

<sub>Verifier: Verified fileProcessing.js:142-143 hardcodes workerSrc to cdnjs.cloudflare.com; client/package.json declares pdfjs-dist ^4.10.38. Reachable via processDocumentFile:831 → processPdfFile:476/renderPdfPagesToImages:493 → loadPdfjs; getDocument needs the worker, so a CDN-blocked/air-gapped host fails PD</sub>

---

### 146. Admin routes hardcode 'contents' while the platform honors CONTENTS_DIR — admin edits silently target the wrong directory

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `config` `sev:medium`

**Files:**
- `server/routes/admin/apps.js:612`
- `server/routes/admin/models.js:202`
- `server/routes/admin/prompts.js:545`
- `server/routes/admin/groups.js:541`
- `server/routes/admin/configs.js:161`
- `server/routes/admin/tools.js:128`
- `server/routes/admin/backup.js:21`

**Problem:** CONTENTS_DIR is a documented deployment option, and configCache/configLoader, migrations, TokenStorageService, FileSystemHandler all resolve via config.CONTENTS_DIR. But apps.js, models.js, prompts.js, groups.js, configs.js, auth.js, ui.js and sources.js hardcode `join(rootDir, 'contents', ...)`; tools.js uses a third variant (`process.env.CONTENTS_DIR || 'contents'`). With a custom CONTENTS_DIR every admin save writes to `<root>/contents/`, which the server never reads — the API reports success, cache refresh reloads unchanged data, deletes 404. backup.js is worse: it uses a `__dirname`-relative contents path, ignoring both CONTENTS_DIR and getRootDir()'s packaged-binary/APP_ROOT_DIR handling, so backup export/import targets a wrong (possibly read-only pkg snapshot) path.

**Evidence:** apps.js:612 `const appsDir = join(rootDir, 'contents', 'apps')`; tools.js:128 `const contentsDir = process.env.CONTENTS_DIR || 'contents'`; configLoader.js:13 `const contentsDir = config.CONTENTS_DIR`; backup.js:21 `const contentsPath = path.join(__dirname, '../../../contents')`; pathUtils.js:9-12 shows getRootDir() diverges from __dirname when packaged/APP_ROOT_DIR is set; docs/INSTALLATION.md:670 documents CONTENTS_DIR.

**Recommended fix:** Add one shared `getContentsPath(...segments)` helper built on getRootDir()+config.CONTENTS_DIR and use it everywhere; delete the three divergent resolution styles.

<sub>Verifier: Verified: config.CONTENTS_DIR (config.js:22,61) is the canonical base used by configLoader.js:13, migrations runner:294, TokenStorageService, FileSystemHandler. Admin writes hardcode literal 'contents' (apps.js:612, models.js:202, prompts.js:545, groups.js:541, configs.js:161, auth.js, ui.js, source</sub>

---

### 147. Dependency automation points at the wrong manifests — shipped deps drift, unused root copies get bumped

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `.github/dependabot.yml:8`
- `package.json:122`
- `client/package.json:23`
- `server/package.json:31`

**Problem:** Dependabot only watches the root npm manifest (directory: '/'), but shipped code lives in client/ and server/ with their own package.json files. Root 'dependencies' duplicates client/server libs, so dependabot bumps unused root copies while the real ones stagnate: root archiver ^8.0.0 (bumped in commit ceaa531) vs server archiver ^7.0.1 (the copy browserExtension.js actually resolves); root react-resizable-panels ^4.12.0 vs client ^3.0.4; root axios ^1.18.1 vs client ^1.16.0; root react-icons ^5.7.0 vs client ^5.5.0. No github-actions ecosystem entry either, so archived actions (actions-rs) linger. Compounds the root-manifest duplication flagged separately.

**Evidence:** .github/dependabot.yml:8-9 has a single entry `package-ecosystem: 'npm' / directory: '/'`. package.json:124 '"archiver": "^8.0.0"' vs server/package.json:31 '"archiver": "^7.0.1"'; package.json:135 '"react-resizable-panels": "^4.12.0"' vs client/package.json:46 '"react-resizable-panels": "^3.0.4"'. git log: 'ceaa531 build(deps): bump archiver from 7.0.1 to 8.0.0' touched only the root.

**Recommended fix:** Add dependabot entries for /client, /server, /nextcloud-app and github-actions. Remove client-only libs (@monaco-editor/react, file-saver, react-icons, html-to-image, react-resizable-panels) from root dependencies, keeping only what shared/ and scripts/ truly need.

<sub>Verifier: All claims verified. dependabot.yml:8-9 has one npm entry at directory '/', which never recurses into client/ or server/ manifests. Version drift confirmed: archiver root ^8.0.0 (pkg:124) vs server ^7.0.1 (server:31); react-resizable-panels ^4.12.0 vs client ^3.0.4; axios ^1.18.1 vs client ^1.16.0; </sub>

---

### 148. Release automation committed garbage version "fix-issue-1137-lVuXg" into every package.json

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `package.json:3`
- `client/package.json:3`
- `server/package.json:3`
- `package-lock.json:3`
- `scripts/sync-release-version.js:28`
- `.github/workflows/build-binaries.yml:329`

**Problem:** Root, client, and server package.json (plus the lockfile) all carry version "fix-issue-1137-lVuXg" — a branch name, committed by the build-binaries workflow's commit-version job after a workflow_dispatch with a non-tag input. sync-release-version.js performs zero validation of the tag (line 28 only strips a leading 'v'). Downstream, build-sea.cjs names binaries `ihub-apps-vfix-issue-1137-lVuXg-…`, updateService.compareVersions parses it to zeros so update checks misfire, electron-builder rejects non-semver versions for `electron:build`, and the admin UI displays it.

**Evidence:** package.json:3 '"version": "fix-issue-1137-lVuXg"' (same in client/package.json:3, server/package.json:3, package-lock.json:3). scripts/sync-release-version.js:28 `const version = releaseTag.startsWith('v') ? releaseTag.slice(1) : releaseTag;` — no semver check. build-binaries.yml:330-335 runs `node scripts/sync-release-version.js ${{ env.VERSION }} --commit` and `git push origin HEAD:…` with whatever workflow_dispatch input was typed. build-sea.cjs:14,55 embeds the version in binary names.

**Recommended fix:** Reset all three version fields to the latest real release. Add a semver regex guard (e.g. /^v?\d+\.\d+\.\d+/) to sync-release-version.js that exits non-zero otherwise, and make the commit-version job run only on `release` events, not arbitrary workflow_dispatch input.

<sub>Verifier: Verified: all four package.json/lockfile carry "fix-issue-1137-lVuXg" at HEAD (package.json:3 etc.). sync-release-version.js:28 does zero validation; build-binaries.yml:322-335 pushes raw workflow_dispatch input. build-sea.cjs:14,55 embeds it in binary names; updateService.js:242 parses it to 0 (par</sub>

---

### 149. Remove 5 default tools whose script files no longer exist (crash on invocation)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `server/defaults/config/tools.json:101`
- `server/defaults/config/tools.json:163`
- `server/defaults/config/tools.json:205`
- `server/defaults/config/tools.json:245`
- `server/defaults/config/tools.json:334`
- `server/toolLoader.js:627`
- `examples/config/tools.json`

**Problem:** The default tools.json (copied to contents/ on every fresh install by copyDefaultConfiguration) registers five enabled tools — deepResearch, researchPlanner, evaluator, queryRewriter, answerReducer — whose script files do not exist in server/tools/ (the directory contains only 11 files, none matching). runTool does `await import(`./tools/${scriptName}`)`, so any LLM or app that calls these tools throws ERR_MODULE_NOT_FOUND at runtime. examples/config/tools.json repeats the same broken entries, and no migration removes the definitions.

**Evidence:** server/defaults/config/tools.json:101 `"script": "deepResearch.js"`, :163 `researchPlanner.js`, :205 `evaluator.js`, :245 `queryRewriter.js`, :334 `answerReducer.js` — verified none exist via `find server/tools -type f`. Execution path: server/toolLoader.js:627 `const mod = await import(`./tools/${scriptName}`);`. No migration removes these definitions (V025 only rewrites app.tools arrays).

**Recommended fix:** Delete the five tool definitions from server/defaults/config/tools.json and examples/config/tools.json (or restore/replace the scripts if the deep-research pipeline is still wanted). Add a startup validation in toolLoader that warns when a configured script file is missing.

<sub>Verifier: Facts hold: tools.json:101/163/205/245/334 declare scripts absent from repo (find + git history confirm), no enabled:false, and toolLoader.js:627 import would throw ERR_MODULE_NOT_FOUND. examples/config/tools.json:138-376 repeat them; no migration removes them. But no default/contents app references</sub>

---

### 150. 13 admin surfaces do unsynchronized read-modify-write of the whole platform.json; AdminAuthPage injects client-side defaults on save

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `config` `sev:medium`

**Files:**
- `client/src/features/admin/pages/AdminAuthPage.jsx:104`
- `client/src/features/admin/components/JiraConfig.jsx:69`
- `client/src/features/admin/pages/AdminLoggingPage.jsx:301`
- `client/src/features/admin/components/CloudStorageConfig.jsx`
- `client/src/features/admin/pages/AdminTelemetryPage.jsx`

**Problem:** 13 admin components/pages (AdminAuthPage, JiraConfig, CloudStorageConfig, IFinderConfig, CookieSettingsConfig, AdminLoggingPage, AdminTelemetryPage, AdminOAuth* pages, AdminMcpGatewayPage, ...) each GET /admin/configs/platform, mutate one section, and POST the entire config back with no version/ETag check — two open admin tabs silently clobber each other (last write wins), including auth settings. AdminAuthPage is worst: it shallow-merges the server config over ~65 lines of hardcoded client defaults, so clicking Save writes sections never present in platform.json (ntlmAuth, authDebug, localAuth with jwtSecret placeholder) and posts the config loaded at page-mount, clobbering intervening changes.

**Evidence:** AdminAuthPage.jsx:18-83 (hardcoded default auth/ntlmAuth/authDebug config), :104-107 shallow merge `setConfig(prev => ({...prev, ...data}))`, :118-131 wholesale POST of `config`. JiraConfig.jsx:69-83 GET-then-POST `{...response.data, jira}`. AdminLoggingPage.jsx:301-313 `platformConfig.authDebug = authDebugConfig; POST platformConfig`. `grep -l "configs/platform" features/admin` returns 13 files.

**Recommended fix:** Add a section-scoped endpoint (e.g. PATCH /admin/configs/platform/:section) or optimistic concurrency (If-Match on config hash) on the server, and a shared usePlatformConfigSection hook on the client. Delete AdminAuthPage's duplicated client defaults; let server defaults/migrations own them.

<sub>Verifier: Core claim verified: POST /admin/configs/platform (configs.js:248-377) has no version/ETag guard; AdminAuthPage.jsx:118-131 POSTs a mount-time snapshot with no re-GET (:104-107 merge over :18-83 defaults), so concurrent admin saves clobber allowlisted sections (last-write-wins). But two overstatemen</sub>

---

### 151. ESLint config enables no recommended rules — no-undef is off repo-wide, letting crash-class bugs pass lint

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `eslint.config.js:41`

**Problem:** The flat ESLint config never applies `@eslint/js` recommended rules — the only enabled core rules are `no-unused-vars` (warn) and `no-console: off`, so `no-undef`, `no-dupe-keys`, `no-unreachable`, `no-fallthrough`, etc. are all disabled. This is the direct reason ~14 `error: e`/`error: err` ReferenceError bugs (see separate finding) shipped despite CLAUDE.md mandating `npm run lint:fix` before every commit — the quality gate exists but cannot see undefined variables.

**Evidence:** eslint.config.js:41-55 — the global rules block contains only `'no-unused-vars': ['warn', {...}]` and `'no-console': 'off'`; there is no `js.configs.recommended` import or spread anywhere in the file. Running lint today passes while server/services/UsageEventLog.js:32 references an undefined `e`.

**Recommended fix:** Import `js from '@eslint/js'` and spread `js.configs.recommended` into the base config (or at minimum add `'no-undef': 'error'`), then fix the resulting violations. The known violations are the ~14 catch-logging bugs.

<sub>Verifier: Verified: eslint.config.js:41-50 enables only no-unused-vars(warn)+no-console(off); no @eslint/js import, no js.configs.recommended spread (grep: lines 59/74/78 are @eslint-react only); server block (100-110) has no rules. Empirically ran eslint on UsageEventLog.js:32 (undefined `e`) — reported only</sub>

---

### 152. Magic-prompt LLM endpoint is not rate limited due to singular/plural path mismatch

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:medium`

**Files:**
- `server/routes/magicPromptRoutes.js:18`
- `server/middleware/setup.js:565`
- `server/middleware/auditLogger.js:29`

**Problem:** The route is mounted at `/api/magic-prompt` (singular) but the public rate limiter is mounted at `/api/magic-prompts` (plural). Express prefix matching means `/api/magic-prompt` is NOT under `/api/magic-prompts`, so the limiter never applies. The endpoint calls simpleCompletion() (a real, billable LLM request), making it an unthrottled abuse/cost vector. The same singular/plural mismatch appears in the audit EXCLUDED_SEGMENTS list ('magic-prompts'), so magic-prompt POSTs are also mis-classified for audit purposes.

**Evidence:** magicPromptRoutes.js:18 `buildServerPath('/api/magic-prompt')`; setup.js:565 `app.use(buildApiPath('/magic-prompts'), rateLimiters.publicApiLimiter)`; auditLogger.js:29 `'magic-prompts',` in EXCLUDED_SEGMENTS. No other limiter covers the singular path.

**Recommended fix:** Make the paths consistent — either rename the route to /api/magic-prompts (breaking; confirm with owner) or change the limiter and audit-exclusion segments to 'magic-prompt'. Prefer fixing the infra references to match the route.

<sub>Verifier: All three claims verified. magicPromptRoutes.js:18 registers /api/magic-prompt (singular); setup.js:565 mounts publicApiLimiter at /api/magic-prompts (plural). Express prefix matching means the singular route is uncovered; no global limiter exists (setup.js:556-579). Handler calls simpleCompletion (</sub>

---

### 153. Supported languages hardcoded in two places for the translations endpoint

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `server/routes/chat/dataRoutes.js:558`
- `server/configCache.js:317`

**Problem:** The translations endpoint hardcodes `const supportedLanguages = ['en', 'de']` and configCache hardcodes `this.defaultLocales = ['en', 'de']`. Adding a new UI language requires code edits in at least these two spots; a locale file added without touching them is silently ignored by /api/translations/:lang (falls back to default). This makes localization changes code changes rather than config changes.

**Evidence:** dataRoutes.js:558 `const supportedLanguages = ['en', 'de'];`. configCache.js:317 `this.defaultLocales = ['en', 'de'];`.

**Recommended fix:** Derive supported languages from a single source (e.g. loaded locale files or a ui.json languages list) and reuse it in both the translations endpoint and configCache preload.

<sub>Verifier: Both lines exist verbatim: dataRoutes.js:558 `supportedLanguages=['en','de']` and configCache.js:317 `defaultLocales=['en','de']`. Traced /api/translations/:lang for a new 'fr' locale: lines 571-578 force lang→defaultLang, silently ignoring the fr file. loadAndCacheLocale (configCache.js:1138) loads</sub>

---

### 154. config.js spreads all of process.env into the exported config, making envalid validation decorative

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `server/config.js:53`
- `server/middleware/setup.js:260`
- `server/middleware/setup.js:277`

**Problem:** config.js carefully declares ~30 env vars with envalid, then spreads `...process.env` into the frozen export. Any undeclared key resolves silently (config.JWT_SECRET, config.USE_HTTPS in setup.js are not in the schema), so typos and undeclared dependencies are invisible, and the module exports every secret in the environment on one object. The declared-schema benefit (defaults, types, discoverability) is lost for exactly the keys that matter most (JWT_SECRET, USE_HTTPS).

**Evidence:** config.js:52-53 `const config = Object.freeze({ ...process.env, PORT: env.PORT, ... })`. Undeclared consumers: setup.js:260 `config.JWT_SECRET || tokenStorageService.getJwtSecret() || 'fallback-session-secret'` and :277 `secure: config.USE_HTTPS === 'true'` — neither JWT_SECRET nor USE_HTTPS appears in the cleanEnv schema (config.js:11-50).

**Recommended fix:** Remove the process.env spread; add JWT_SECRET, USE_HTTPS and any other actually-used vars to the cleanEnv schema so the validation layer is real.

<sub>Verifier: config.js:53 spreads `...process.env` (verified). JWT_SECRET/USE_HTTPS are not in the cleanEnv schema (grep: no matches in config.js) yet are consumed via config at setup.js:260,277 and tokenService.js:62 — reaching config only through the spread, bypassing envalid's defaults/types. Mechanism is rea</sub>

---

### 155. Prune duplicate and dead npm scripts in package.json

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `package.json:42`
- `package.json:47`
- `package.json:90`
- `package.json:113`

**Problem:** Script sprawl in package.json: `test:legacy` (line 90) and `test:adapters` (91) are character-for-character identical; `security:audit` and `security:audit:admin` (113-114) are identical; `docs:build:html` (45) is a pure alias of `docs:build`; `docs:copy` (47) is referenced by nothing (build uses docs:copy:all); line 42 is a corrupted comment key `"// === DOCUMENTATION === && npm run docs:build:pdf "` — leftover junk. None of the jest/playwright test scripts run in CI (only test:a11y does), so ~25 test scripts are maintained on faith. The non-semver committed version this finding also flagged is consolidated into the release-automation finding.

**Evidence:** package.json:90-91 both read `npm run test:openai && npm run test:mistral && npm run test:anthropic && npm run test:google && npm run test:bedrock && npm run test:vllm-images`; :113-114 both `node scripts/audit-admin-endpoints.js`; :42 stray `&& npm run docs:build:pdf` inside a comment key; grep across workflows shows only `npm run test:a11y` in .github/workflows/accessibility.yml:47.

**Recommended fix:** Delete the duplicate/alias/dead scripts, fix the corrupted comment key, and wire at least test:quick into CI so test scripts can't silently rot.

<sub>Verifier: All claims verified. package.json:90/91 byte-identical; :113/114 identical (node scripts/audit-admin-endpoints.js); :45 docs:build:html is pure `npm run docs:build` alias; :47 docs:copy dead (grep: all other hits are docs:copy:all); :42 is a no-op junk comment key. Workflow grep confirms only test:a</sub>

---

### 156. platformConfigSchema drifts from shipped defaults and resurrects the removed jwtSecret field

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `server/validators/platformConfigSchema.js:102`
- `server/validators/platformConfigSchema.js:143`
- `server/validators/platformConfigSchema.js:60`
- `server/routes/admin/configs.js:190`
- `config.env:40`

**Problem:** platformConfigSchema never validates platform.json at runtime (its only consumer is schemaExport.js feeding the admin JSON-schema editor) and has drifted: auth.mode defaults 'proxy' vs shipped 'local'; localAuth.showDemoAccounts defaults false vs shipped true; rateLimitSchema lacks the `oauthApi` section shipped in defaults/platform.json:146-150, so the editor flags valid config; and localAuth.jwtSecret defaults to '${JWT_SECRET}' although migration V010 removed jwtSecret as obsolete after the RS256 switch (V009). admin/configs.js:190 re-injects `jwtSecret: '${JWT_SECRET}'` in a fallback default that also defines `anonymousAuth` twice, and config.env:40 still documents JWT_SECRET with a concrete example secret committed to the repo.

**Evidence:** platformConfigSchema.js:102 `.default('proxy')` vs defaults/config/platform.json:86 `"mode": "local"`; :143 `jwtSecret: z.string().default('${JWT_SECRET}')` vs V010__remove_jwt_secret.js ('legacy jwtSecret field superseded by RS256'); :144 `showDemoAccounts: z.boolean().default(false)` vs defaults platform.json:116 `true`; rateLimitSchema has no oauthApi; configs.js:171-200 object literal defines `anonymousAuth` twice; config.env copied next to every SEA binary by build-sea.cjs:444-446.

**Recommended fix:** Sync the schema with shipped defaults, add oauthApi to rateLimitSchema, delete the jwtSecret remnants (schema, admin fallback, config.env example secret), and consider actually validating platform.json against the schema at load time so drift is caught.

<sub>Verifier: All facts verified: schema mode 'proxy' vs shipped 'local' (schema:102/defaults:86); showDemoAccounts false vs true (:144/:116); rateLimitSchema lacks oauthApi (:60-66) though shipped+used (rateLimiting.js:97); localAuth.jwtSecret '${JWT_SECRET}' resurrected post-V010, unread by tokenService.js:60-7</sub>

---

### 157. Root package.json ships client-only libraries into production; server imports undeclared proxy-agent packages

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `package.json:122`
- `package.json:39`
- `server/utils/httpConfig.js:9`
- `server/utils/httpConfig.js:10`
- `server/package.json:16`

**Problem:** Root dependencies include frontend-only packages already declared at different versions in client/package.json (@monaco-editor/react, react-icons, file-saver, html-to-image, react-resizable-panels, axios). build:config copies the root package.json into dist and build:package runs `npm ci --omit=dev` there, so production servers install React UI libraries for nothing. Conversely, server/utils/httpConfig.js imports http-proxy-agent/https-proxy-agent, which are absent from server/package.json — they resolve only via root/dist node_modules or a transitive copy (https-proxy-agent@7.0.6), so which major version loads depends on hoisting, despite a version-sensitive TLS workaround ('verified through 9.0.0'). Duplicated deps drift: dotenv ^17 vs ^16, archiver ^8 vs ^7.

**Evidence:** package.json:123-135 lists `@monaco-editor/react`, `react-icons`, `file-saver`, `html-to-image`, `react-resizable-panels` as root prod deps; grep shows zero imports under server/ or shared/. package.json:39 `build:package: cd dist && npm ci --omit=dev`. httpConfig.js:9-10 imports both proxy agents while server/package.json (lines 16-70) declares neither; server/package-lock.json:7574 shows https-proxy-agent 7.0.6 only as transitive; root declares ^9.1.0; httpConfig.js:16 'Workaround for https-proxy-agent >=7.0.0 (verified through 9.0.0)'.

**Recommended fix:** Add http-proxy-agent/https-proxy-agent to server/package.json pinned to the range the TLS workaround was verified against; remove client-only and server-duplicated packages from root dependencies (keep only what root scripts truly need); align duplicated versions.

<sub>Verifier: All facts verified. package.json:123-135 lists 5 client libs; grep shows no server/shared imports (client/package.json:18-46 has them, drift confirmed: react-resizable-panels 3 vs 4). build:config/build:package (lines 37,39) install them into dist for nothing. httpConfig.js:9-10 imports proxy agents</sub>

---

### 158. Shipped default apps fail their own Zod schema and reference non-existent models

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `server/defaults/apps/web-chat.json:68`
- `server/defaults/apps/zoll-tarif-assistant.json:20`
- `server/defaults/apps/social-media.json:19`
- `server/defaults/apps/translator.json:19`
- `server/utils/resourceLoader.js:360`

**Problem:** Two shipped default apps fail the project's own Zod schema: web-chat.json carries AppCreationWizard UI-state keys (`useAI`, `useTemplate`, `useManual`) leaked into persisted config, and zoll-tarif-assistant.json uses per-language greeting strings where the schema requires `{title, subtitle}` objects. Validation failures only log warnings and keep the raw item (resourceLoader.js:360), so every fresh install logs schema warnings and these apps never get Zod defaults. Additionally three default apps reference non-existent models (web-chat → gemini-2.5-flash-preview-05-20, translator → gemini-1.5-flash, social-media → gpt-3.5-turbo), and no default model sets `"default": true`, so `models.find(m => m.default)` consumers (e.g. magicPromptRoutes.js:32) get undefined.

**Evidence:** web-chat.json:68-70 `"useAI": false, "useTemplate": true, "useManual": false`; zoll-tarif-assistant.json:20 `"greeting": {"en": "Ready to find..."}` vs schema record of `z.object({title, subtitle})` (appConfigSchema.js:227-233); web-chat.json:17 `"preferredModel": "gemini-2.5-flash-preview-05-20"` — no such id under server/defaults/models/ (verified by scanning all model JSONs); resourceLoader.js:360 `logger.warn('Resource validation issues', ...)` then returns the unparsed item.

**Recommended fix:** Strip the wizard keys, fix the greeting shape (or relax the schema to accept plain strings since AppChat.jsx:904-908 supports them), update preferredModel references to shipped models, and mark one default model `"default": true`. Add a CI test that validates server/defaults/** against the validators.

<sub>Verifier: All claims verified. Ran the real appConfigSchema (.strict(), appConfigSchema.js:381): web-chat.json:68-70 fails on 'useAI/useTemplate/useManual'; zoll-tarif-assistant.json:20 fails ('greeting.en: Expected object, received string' vs :227-233). resourceLoader.js:360-389 warns and returns raw item; a</sub>

---

### 159. knownRoutes is triplicated and all three copies have drifted from App.jsx routes

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `config` `sev:low`

**Files:**
- `client/index.html:34`
- `client/src/utils/runtimeBasePath.js:42`
- `client/src/utils/runtimeBasePath.js:125`
- `client/src/App.jsx:686`

**Problem:** CLAUDE.md mandates keeping knownRoutes in sync with App.jsx, yet there are three hand-maintained copies (client/index.html, runtimeBasePath.js detectBasePath, runtimeBasePath.js getBasePath cache validation) that already disagree: index.html lacks 'office' and 'nextcloud', which the runtimeBasePath.js copies have. All three miss App.jsx's top-level 'unauthorized', 'forbidden', and 'server-error' routes. On deployments where the server doesn't inject __SERVER_BASE_PATH__ (no X-Forwarded-Prefix), landing on /ihub/forbidden misdetects '/ihub/forbidden' as the base path, breaking asset loading and routing. The lists also contain 'chat' and 'auth', which have no top-level App.jsx route — drift in both directions.

**Evidence:** index.html:34-48 array ends `'s', 'setup', 'tools'` (no office/nextcloud); runtimeBasePath.js:42-58 includes `'office', 'nextcloud'`; a third copy at runtimeBasePath.js:125-141. App.jsx:686-688 `<Route path="unauthorized" .../> <Route path="forbidden" .../> <Route path="server-error" .../>` appear in none of the lists.

**Recommended fix:** Define the list once (e.g. a shared constant emitted into index.html at build time by the existing auth-gate Vite plugin, or generated from App.jsx), add the missing error routes, and remove routes that no longer exist. At minimum, deduplicate the two copies inside runtimeBasePath.js.

<sub>Verifier: Verified: three knownRoutes copies (index.html:34, runtimeBasePath.js:42 & :125); index.html omits office/nextcloud the others have; all three lack App.jsx:686-688 unauthorized/forbidden/server-error; chat/auth have no top-level route. Drift is real, violating CLAUDE.md's MUST. But server always inj</sub>

---

## ⚡ Performance

### 160. Heavy export libraries (docx, pptxgenjs, write-excel-file) are pulled into the eager bundle; 'xlsx' dependency is dead

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `performance` `sev:medium`

**Files:**
- `client/src/utils/exportFormats.js:1`
- `client/src/api/endpoints/apps.js:5`
- `client/vite.config.js:75`
- `client/package.json:54`
- `client/src/utils/exportFormats.js:908`

**Problem:** exportFormats.js statically imports docx, pptxgenjs, and write-excel-file at module top, and is statically imported by api/endpoints/apps.js (for two small filename/title helpers, re-exported from api/index.js) and via ExportDialog ← ChatMessage ← AppChat ← App.jsx — so all three heavy libraries land in the initial dependency graph. The vite manualChunks entry isolates a package named 'xlsx', but the code uses 'write-excel-file'; the actual 'xlsx' (SheetJS 0.18.5, with known CVEs) is in package.json yet imported nowhere. exportFormats.js also `await import('docx')` twice despite the static import, defeating lazy-load intent.

**Evidence:** exportFormats.js:1-3 `import writeXlsxFile from 'write-excel-file'; import { Document, ... } from 'docx'; import PptxGenJS from 'pptxgenjs';` apps.js:5 `import { buildChatExportFilename, buildChatExportTitle } from '../../utils/exportFormats';` vite.config.js:75 `xlsx: ['xlsx']` while `grep -rn "from 'xlsx'" client/` returns nothing; package.json:54 `"xlsx": "^0.18.5"`. exportFormats.js:908/938 `await import('docx')` after the static import.

**Recommended fix:** Remove the unused 'xlsx' dependency and its chunk entry. Move the filename/title helpers out of exportFormats.js into a tiny module, and load exportToXLSX/DOCX/PPTX via dynamic import from ExportDialog so docx/pptxgenjs/write-excel-file only load when a user actually exports.

<sub>Verifier: Core claim holds: exportFormats.js:1-3 statically imports docx/pptxgenjs/write-excel-file, reached eagerly two ways — apps.js:5 via api barrel (App.jsx:156→api/api.js→index.js→apps.js) AND App.jsx:9→AppRouterWrapper→AppChat→ChatMessage:54→ExportDialog (uses exportToDOCX/PPTX/XLSX, so no tree-shaking</sub>

---

### 161. StateManager serializes the entire state on every update and step (O(N^2) per run)

**Severity:** medium · **Confidence:** ✅ verified · **Effort:** medium  
**Labels:** `performance` `sev:medium`

**Files:**
- `server/services/workflow/StateManager.js:660`
- `server/services/workflow/StateManager.js:196`
- `server/services/workflow/StateManager.js:376`

**Problem:** `_validateStateSize` does a full `JSON.stringify(state)` + `Buffer.byteLength` on every `update()` and every `addStep()`. `executeNode` performs ~2 updates and 2 addSteps per node (plus retries), so state is fully serialized ~4x per node. Because state.data accumulates _taskResults, _citations, _stepLogs, and nodeResults that grow with the run, serialization cost per node grows with total run size — an O(N^2) tax on long agent/research runs, on top of actual checkpoint writes. `_sanitizeForEvent` also re-stringifies each result for events.

**Evidence:** StateManager.js:661 `const stateJson = JSON.stringify(state)` invoked from update:196 and addStep:376; MAX_STATE_SIZE is 50MB (line 23) so the stringify walks the whole growing object each time. executeNode issues update (887), addStep (856,982), markNodeCompleted per node.

**Recommended fix:** Size-check only on checkpoint (disk write) rather than on every in-memory mutation, or track an incremental byte estimate; avoid full stringify on the hot per-node update path.

<sub>Verifier: Verified: _validateStateSize (StateManager.js:661) does unconditional JSON.stringify(state), called from update:196 and addStep:376. executeNode serializes ~4x/node: addStep 856/982, update 887, plus run-loop update 727. nodeResults/history/_taskResults accumulate per node (comment 458-462 notes ~40</sub>

---

### 162. OpenAI proxy logs full tool definitions and responses at info level on every request

**Severity:** low · **Confidence:** ✅ verified · **Effort:** small  
**Labels:** `performance` `sev:low`

**Files:**
- `server/routes/openaiProxy.js:166`
- `server/routes/openaiProxy.js:525`

**Problem:** Every inference request logs the full tools array via `JSON.stringify(tools, null, 2)` at info level, and every non-streaming response logs the entire generic result. On a busy inference endpoint this bloats logs, costs CPU serializing large payloads on the hot path, and can persist potentially sensitive prompt/tool content to log storage.

**Evidence:** Line 166-176 `logger.info('[OpenAI Proxy] Incoming request', { ... tools: JSON.stringify(tools, null, 2), ... })`. Line 525-528 `logger.info('[OpenAI Proxy] Generic result', { result: JSON.stringify(genericResult, null, 2) })`.

**Recommended fix:** Drop the full-payload fields to `logger.debug`, or log only counts/ids (e.g. tool names, content length) at info level.

<sub>Verifier: Code matches exactly. openaiProxy.js:173 logs `tools: JSON.stringify(tools, null, 2)` inside the info-level "Incoming request" log; openaiProxy.js:525-528 logs `result: JSON.stringify(genericResult, null, 2)` at info. Default log level is 'info' (logger.js:6), so both emit. Route is mounted at serve</sub>

---

## 🧪 Testing

### 163. Wire the unit/integration test suites into CI — nothing runs today

**Severity:** high · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `testing` `sev:high`

**Files:**
- `.github/workflows/accessibility.yml:47`
- `package.json:76`
- `server/jest.config.js:14`

**Problem:** The repo contains ~134 files in server/tests, plus tests/unit, tests/integration and tests/e2e, but no GitHub workflow ever executes them. The only test run in CI is the accessibility Playwright suite; every other workflow builds, lints, or packages. With zero enforcement, the suites have silently rotted: tests reference deleted paths and incompatible runners without anyone noticing. An unenforced ~20k-line test corpus is a liability, not an asset.

**Evidence:** grep for 'npm run test' across .github/workflows/*.yml matches only accessibility.yml:47 ('run: npm run test:a11y -- --project=chromium'). build-binaries.yml, docker-ci.yml, auto-lint-format.yml contain no test step. package.json:76-88 defines test:all/test:unit/test:integration and server/package.json:10 defines a jest run — none referenced in CI. server/tests/*.test.js totals 19,575 lines.

**Recommended fix:** Add a PR workflow that runs the subset of tests that actually pass (start with tests/unit and the node:test files via `node --test`), then ratchet up. Delete or quarantine suites that cannot be made green so the signal stays trustworthy.

---

### 164. Root Jest suites import files and exports that don't exist — test:unit/test:integration cannot run

**Severity:** high · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `testing` `sev:high`

**Files:**
- `tests/unit/server/locale-override.test.js:5`
- `tests/integration/api/chat.test.js:2`
- `tests/integration/models/model-integration.test.js:1`

**Problem:** Several suites under the documented root test framework (tests/README.md, npm run test:unit / test:integration / test:all) fail at import time. locale-override.test.js imports `{ ConfigCache } from '../configCache.js'` — the path resolves to nonexistent tests/unit/configCache.js, and server/configCache.js has no named ConfigCache export anyway (only a default export). chat.test.js and model-integration.test.js use `../utils/helpers.js` and `../../server/...`, which resolve to nonexistent tests/integration/utils/ and tests/server/; helpers live at tests/utils/, the server at ../../../server/. These suites were written against a layout that never matched or has changed.

**Evidence:** tests/unit/server/locale-override.test.js:5 `import { ConfigCache } from '../configCache.js';` — tests/unit/configCache.js does not exist; `grep '^export' server/configCache.js` shows only `resolveEnvVarsInObject` and `export default configCache`. tests/integration/models/model-integration.test.js:1 `from '../../server/adapters/index.js'` resolves to nonexistent tests/server/adapters. tests/integration/api/chat.test.js:19 `await import('../../server/server.js')` resolves to nonexistent tests/server/server.js.

**Recommended fix:** Fix the relative paths (../../utils/, ../../../server/) and import the default configCache export, or delete these never-run suites. Add the suites to CI immediately after so regressions surface.

---

### 165. server/tests mixes three incompatible test runners — `npm test` in server/ fails on 83 of 118 files

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** medium  
**Labels:** `testing` `sev:medium`

**Files:**
- `server/jest.config.js:14`
- `server/package.json:10`
- `server/tests/openaiAdapter.test.js:1`
- `server/tests/adminRescue.test.js:1`

**Problem:** server/package.json's `test` script runs Jest with testMatch `**/tests/**/*.test.js`, but 83 of the 118 *.test.js files there are not Jest suites: most are plain node scripts with `assert`/console checks meant to be run as `node server/tests/x.test.js` (e.g. openaiAdapter.test.js, all agent-*.test.js), and 10 use `node:test` (adminRescue.test.js imports describe/it from 'node:test'). Jest fails each with 'must contain at least one test'. Root and server also pin different Jest majors (30.4.2 vs 29.7.0). Three runner conventions make the suite unrunnable as a whole.

**Evidence:** server/jest.config.js:14 `testMatch: ['**/tests/**/*.test.js', ...]`; server/tests/openaiAdapter.test.js:1-17 is a top-level `assert.deepStrictEqual(...)` script with no describe/it; server/tests/agent-budget-loop.test.js:10 says 'Run directly: node server/tests/agent-budget-loop.test.js'; server/tests/adminRescue.test.js:1 `import { describe, it, ... } from 'node:test'`. Count: 83/118 files lack any top-level describe/it/test call. package.json:156 jest ^30.4.2 vs server/package.json:75 jest ^29.7.0.

**Recommended fix:** Pick one runner (node:test needs no deps and already fits 10 files plus all plain scripts with minor wrapping). Rename non-conforming files (.test.js → .manual.js) or convert them, and align the Jest major if Jest stays.

---

### 166. tokenStats.test.js never runs: no test runner matches it and vitest is configured nowhere

**Severity:** low · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `testing` `sev:low`

**Files:**
- `client/src/features/admin/utils/tokenStats.test.js`
- `tests/config/jest.config.js:35`
- `package.json:164`

**Problem:** client/src/features/admin/utils/tokenStats.test.js is the only test file inside client/src, and no runner executes it: the root jest config's testMatch covers only tests/integration/**, tests/unit/server/** and tests/unit/client/**; server/jest.config.js only matches **/tests/**. Although vitest ^4.1.9 is a root devDependency, there is no vitest.config.* anywhere, no npm script invokes vitest, and no source file imports it (only a concepts/ markdown snippet). The test — and the vitest dependency presumably added for it — silently do nothing, giving false confidence that tokenStats (used by AgentRunDetailPage.jsx) is covered.

**Evidence:** tests/config/jest.config.js:35 `testMatch: ['**/tests/integration/**/*.test.js', '**/tests/unit/server/**/*.test.js', '**/tests/unit/client/**/*.test.jsx']` — does not match client/src/**. `find . -name 'vitest.config.*'` returns none; `grep -rn "from 'vitest'"` matches only concepts/kerberos-authentication markdown. tokenStats itself is live: AgentRunDetailPage.jsx:8 imports aggregateTokenUsage/formatTokenCount.

**Recommended fix:** Move the test to tests/unit/client/ (jest already handles jsx there) and delete the vitest devDependency, or commit to vitest with a real config and script — but pick one runner.

---

## 📄 Documentation

### 167. Consolidate four divergent AI-agent instruction files; AGENTS.md references missing setup.sh

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `docs` `sev:medium`

**Files:**
- `GEMINI.md:1`
- `LLM_GUIDELINES.md:1`
- `AGENTS.md:25`
- `CLAUDE.md:1`

**Problem:** The repo carries four agent-instruction documents at root: CLAUDE.md (880 lines), AGENTS.md (222), GEMINI.md (213), LLM_GUIDELINES.md (150). GEMINI.md is a verbatim copy of LLM_GUIDELINES.md — a diff shows only title and list-numbering differ. AGENTS.md tells agents to run `./setup.sh`, a script that does not exist in the repo, and both GEMINI.md:21 and LLM_GUIDELINES.md:19 instruct agents to maintain 'apps.json, models.json' — legacy monolithic configs long since replaced by per-file contents/apps/*.json and contents/models/*.json. These stale duplicates actively misdirect coding agents.

**Evidence:** `diff <(sed 's/Gemini models/LLMs/' GEMINI.md) LLM_GUIDELINES.md` → only header + '1.' vs '1. ' numbering differences. AGENTS.md:25 `./setup.sh`; `ls setup.sh` → 'No such file or directory' (re-verified). GEMINI.md:21 'configuration files (apps.json, models.json, etc.)'.

**Recommended fix:** Keep CLAUDE.md as the single source; make AGENTS.md a short pointer to it (the emerging cross-vendor standard) and delete GEMINI.md and LLM_GUIDELINES.md. Fix or drop the setup.sh and apps.json/models.json references.

---

### 168. browser-extension README documents a deleted architecture and contradicts the manifest's permissions

**Severity:** medium · **Confidence:** 💡 design suggestion · **Effort:** small  
**Labels:** `docs` `sev:medium`

**Files:**
- `browser-extension/README.md:20`
- `browser-extension/README.md:89`
- `browser-extension/README.md:96`
- `browser-extension/manifest.json:8`

**Problem:** The README describes files that no longer exist ('sidepanel.js Side panel UI (vanilla JS, no build step)', options.js, sidepanel.css) — the UI now lives in client/extension/*.jsx built by Vite, per background.js's own comment. Its security section is false on two counts: 'Tokens never leave the service worker' (background.js:5-8 says the side panel makes its own fetches with tokens in chrome.storage from the React tree) and 'No host permissions at install time' while manifest.json:8 requests `"host_permissions": ["<all_urls>"]`. The 'Load unpacked → pick browser-extension/' instructions also fail unless `npm run extension:build` ran first.

**Evidence:** README.md:20-24 lists sidepanel.js/options.js/sidepanel.css; README.md:89 'Tokens never leave the service worker'; README.md:96-97 'No host permissions at install time'; manifest.json:8 '"host_permissions": ["<all_urls>"]'; background.js:4-13 'Most of the extension's behaviour now lives in the React side-panel app... tokens stored in chrome.storage.{session,local} from the React tree.'

**Recommended fix:** Rewrite the README against the current architecture, and decide deliberately whether `<all_urls>` is required (the documented design was activeTab + on-demand scripting). If <all_urls> stays, update the privacy section; if not, drop it from the manifest.

---

