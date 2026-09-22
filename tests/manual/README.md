# Manual Test Scripts

These scripts are standalone verification aids written while diagnosing specific bugs or
building specific features. They are **not** part of the automated test suite — none of
them match `tests/config/jest.config.js`'s `testMatch` patterns, and none are wired into
any `npm run test:*` script or CI workflow. Run them by hand with `node` (or the
appropriate interpreter) when you need to manually re-verify one of these areas; they are
kept for reference rather than executed automatically.

If you fix a bug in one of these areas going forward, prefer adding real coverage under
`tests/unit/` or `tests/integration/` instead of adding another one-off script here.

| Script                                           | Area                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| `demo-ai-disclaimer-banner-fix.html`             | AI disclaimer banner rendering                           |
| `demo-client-secret-preservation.js`             | OAuth client secret preservation on save                 |
| `manual-test-apikey-persistence.js`              | Model API key persistence                                |
| `manual-test-client-secret-preservation.js`      | OAuth client secret preservation                         |
| `manual-test-model-filtering.js`                 | Model filtering in RequestBuilder                        |
| `manual-test-model-with-provider-key.js`         | Model testing with provider-specific API keys            |
| `manual-test-provider-apikey-persistence-fix.js` | Provider API key persistence                             |
| `manual-test-provider-apikey-persistence.js`     | Provider API key persistence                             |
| `manual-test-provider-apikey-ttl-restart.js`     | Provider API key persistence across TTL refresh/restart  |
| `manual-test-websearch-provider-keys.js`         | Websearch provider API key configuration                 |
| `oauth-auth-code-unit.js`                        | OAuth Authorization Code flow                            |
| `oauth-flow-test.js`                             | OAuth 2.0 Client Credentials flow (end-to-end)           |
| `test-audio-extraction.html`                     | Audio extraction from uploads                            |
| `test-client-secret-preservation.js`             | OAuth client secret preservation                         |
| `test-encryption-workflow.js`                    | Environment variable encryption/decryption               |
| `test-nda-prompt.js`                             | NDA risk-analyzer prompt                                 |
| `test-oidc-provider-selector.sh`                 | OIDC provider template selector                          |
| `test-sources-disabled-fix.js`                   | App editor behavior when the sources feature is disabled |
