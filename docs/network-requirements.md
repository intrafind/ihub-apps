---
description: "Ports, outbound destinations, proxy and TLS settings that firewall and proxy admins need to open for an iHub Apps rollout."
audience: admin
type: reference
---

# Network Requirements

This page lists what the network has to allow for iHub Apps to work: the
inbound path from browsers, the outbound destinations the server contacts, how a
corporate proxy and TLS inspection are handled, and a checklist to test it. It
is meant for the people who run the firewall, the proxy and the reverse proxy.

Only hosts that ship in the product defaults are named. Everything else depends
on what you configure, and is listed as "your configured endpoint".

All outbound requests come from the **iHub server process**, not from users'
browsers. The browser only talks to iHub.

## Inbound: browsers to iHub

| What                              | Detail                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Port                              | The server listens on `PORT`, default `3000`. In production a reverse proxy normally terminates TLS on 443 and forwards to it.                 |
| TLS                               | Terminate TLS at the reverse proxy (recommended) or in the Node server. See [Running with SSL/HTTPS](ssl-https-setup.md).                      |
| Streaming responses (SSE)         | Chat, workflow and agent runs stream over Server-Sent Events. The proxy must not buffer these responses and needs a long read timeout.        |
| WebSocket                         | Realtime voice transcription uses a WebSocket at `/api/voice/realtime`. The proxy must pass the `Upgrade` header.                              |
| `Host` / `X-Forwarded-*` headers  | Forward `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. The voice WebSocket compares the browser's `Origin` header with `Host` and `X-Forwarded-Host` (or the origins in `cors.origin`) and rejects the handshake if none match. |
| `trustProxy`                      | `platform.json` ships `trustProxy: 1`, meaning one proxy hop is trusted when resolving the client IP. Change it if more hops sit in front.     |
| Allowed origins                   | Add the public HTTPS origin to `cors.origin` in `platform.json` (the shipped default is an empty list). The documented pattern is a `${ALLOWED_ORIGINS}` placeholder filled from an environment variable; see [Platform Configuration](platform.md). The voice WebSocket does not honor a `*` wildcard.                                                                          |

Working nginx and Apache configurations, including the SSE and WebSocket
locations and timeouts, are in the
[Production Reverse Proxy Guide](production-reverse-proxy-guide.md). The voice
WebSocket is described in [Voice Transcription](voice-transcription.md), and the
stream formats in [Streaming Events](streaming-events.md). Other listeners, such as the Prometheus
metrics port, are covered under [Telemetry](#telemetry) below.

## Outbound: what the server contacts

### Always needed

None of the shipped defaults requires the internet to start the server. What you
need depends on the features you use, so this group is small: the destinations
of whatever **LLM models you enable**. Without a reachable model endpoint, chat
does not work.

| Destination                                  | Used for                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| The `baseUrl` / `url` of each enabled model  | LLM requests, HTTPS in all shipped provider defaults.          |

The shipped `providers.json` contains these hosts:

| Provider    | Host                                      |
| ----------- | ----------------------------------------- |
| OpenAI      | `api.openai.com`                          |
| Anthropic   | `api.anthropic.com`                       |
| Google      | `generativelanguage.googleapis.com`       |
| Mistral     | `api.mistral.ai`                          |
| OpenRouter  | `openrouter.ai`                           |

Open only the providers whose models you enable. For models you host yourself
(vLLM, LM Studio, Jan.ai and similar), the destination is your configured
endpoint; see [Local LLM Providers](local-llm-providers.md) and [Models](models.md).

### Only if the feature is enabled

| Feature                           | Destination                                                                                                                              | Notes |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Marketplace                       | `raw.githubusercontent.com` (shipped registry catalog), plus `api.github.com` for GitHub-hosted registries, and each registry's own host | On by default. A registry on your own host needs only that host. See [Marketplace](marketplace.md), including the offline marketplace for air-gapped networks. |
| Version check in the admin UI     | `api.github.com` (latest release of the iHub repository)                                                                                 | Set `NO_VERSION_CHECK=true` (or `IHUB_NO_VERSION_CHECK`) to disable it. The request times out quickly, so a blocked host does not hang the admin UI. |
| In-product update                 | `api.github.com` to read the release, then the release asset download URLs (archive, checksums and signature), which are fetched with redirects followed. GitHub normally redirects these to a separate download host, so allow `github.com` and the host your test shows in the redirect                                        | Only when an admin starts an update. See [Update Signing](update-signing.md). |
| Web search: Brave                 | `api.search.brave.com`                                                                                                                   | Needs an API key. |
| Web search: Staan                 | `api.staan.ai`                                                                                                         | Needs an API key. |
| Web page reading (`read_url`)     | Any URL the model asks for                                                                                                               | The server blocks private, loopback and link-local targets (SSRF guard) unless the host is on `ssl.domainWhitelist` or `ssrf.allowedHosts`. See [Web Tools](web-tools.md). |
| OIDC / identity provider          | The issuer, authorization, token and userinfo endpoints of the provider you configure                                                    | Browsers are redirected to the provider and back to `/api/auth/oidc/<provider>/callback`; the server calls the provider directly. See [OIDC Authentication](oidc-authentication.md). |
| LDAP / Active Directory           | Your configured `url`, for example `ldaps://host:636`, or `ldap://host:389` with `starttls`                                              | A TCP connection, not HTTP: the HTTP proxy does not carry it. See [LDAP and NTLM Authentication](ldap-ntlm-authentication.md). |
| Integrations (Jira, iFinder, Nextcloud, Office 365, Google Drive, Entra, A2A agents, MCP servers) | Your configured endpoint for each integration | Some definitions point at provider hosts, for example Google OAuth (`accounts.google.com`, `www.googleapis.com`) for Google Drive. See [Integrations](integrations.md) and the page of each integration. |
| Hosted MCP servers from the marketplace | The URL of each server, for example `mcp.context7.com`, `mcp.deepwiki.com`, `mcp.atlassian.com` | Only after the integration is installed. See [MCP Integration](mcp-integration.md). |
| Realtime voice transcription      | The endpoint of the transcription model you configure                                                                                     | `wss://api.mistral.ai/v1/audio/transcriptions/realtime` for the Mistral model or your own vLLM `/v1/realtime`. The browser never connects there; iHub relays. See [Voice Transcription](voice-transcription.md). |

### Optional

| Feature             | Destination                                                                                              | Notes |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----- |
| Telemetry (OTLP)    | `exporters.otlp.endpoint`, which defaults to `http://localhost:4318` (from `OTEL_EXPORTER_OTLP_ENDPOINT`) | Telemetry is off in the shipped `platform.json` (`telemetry.enabled: false`). |

#### Telemetry

Telemetry is disabled by default and, when enabled, sends data only to the
endpoint you configure. The Prometheus exporter is the reverse direction: it
opens a listener only when telemetry is enabled and the provider is `prometheus` (default port `9464`, host `0.0.0.0` in the shipped defaults; nothing listens there on a default install)
that your monitoring system scrapes, so it is an inbound rule, not an outbound
one. See [Telemetry](telemetry.md).

## Proxy support

iHub sends outbound HTTP and HTTPS requests through a proxy when one is
configured. A fresh installation has no `proxy` block and sends everything
directly.

- Settings: `proxy.enabled`, `proxy.http`, `proxy.https`, `proxy.noProxy` and
  `proxy.urlPatterns` in `platform.json`, editable under
  **Admin -> Security -> Outbound Proxy**.
- Environment: `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are used when the
  platform settings do not set a field. `proxy.enabled: false` ignores both.
- Authentication: put credentials in the proxy URL. Stored URLs are encrypted.
- Scope: `noProxy` hosts go direct. `urlPatterns`, when not empty, proxies only
  matching URLs.
- `noProxy` does not support CIDR ranges, `host:port` entries or a catch-all
  `*`.
- The proxy settings apply to HTTP and HTTPS requests. They are not documented to apply to LDAP or other non-HTTP connections, so plan a direct route for those.

Details and examples: [Proxy Configuration](proxy-configuration.md).

## TLS inspection and private certificate authorities

If the proxy or firewall decrypts HTTPS (TLS interception), iHub sees the
proxy's certificate instead of the real server's, and the request fails with
errors such as "unable to verify the first certificate". The same happens for
internal services with a private or self-signed certificate. There are two
ways to handle it.

1. **Trust the CA (recommended).** Add the interception or private CA to the
   operating system's certificate store on the iHub server, as described in
   [Self-Signed SSL Certificates](ssl-certificates.md).
2. **Bypass validation for named hosts.** In `platform.json`:

   ```json
   {
     "ssl": {
       "ignoreInvalidCertificates": true,
       "domainWhitelist": ["llm.internal.example.com", "*.corp.example.com"]
     }
   }
   ```

   - Defaults: `ignoreInvalidCertificates: false`, `domainWhitelist: []`.
   - Certificate checks are skipped only when `ignoreInvalidCertificates` is
     `true` **and** the target host matches `domainWhitelist`. With an empty
     whitelist nothing is bypassed.
   - Entries are an exact host (`api.example.com`), `*.example.com` or
     `.example.com`. The wildcard forms match subdomains but not
     `example.com` itself.
   - Hosts on the whitelist are also exempt from the private-address rule of the
     SSRF guard, so list only hosts you trust.
   - It applies to outbound HTTP(S) and to `wss://` connections. It is not a
     global switch.

If a proxy needs to be reached over TLS or you inspect traffic to many
destinations, prefer trusting the CA over a long whitelist.

## Connectivity checklist

1. From the iHub server, resolve and reach each destination you enabled, for
   example with `curl -I https://api.openai.com` using the same proxy
   environment as iHub.
2. Under **Admin -> Security -> Outbound Proxy**, run the connectivity test for
   one URL per destination group. The result classifies failures (proxy
   unreachable, `407`, DNS, TLS, timeout). The same check is available as
   `POST /api/admin/proxy/_test`.
3. If the failure is a certificate error, apply [TLS inspection](#tls-inspection-and-private-certificate-authorities)
   before changing anything else.
4. Open a chat in a browser through the production URL and confirm the answer
   streams word by word. A response that arrives all at once means the reverse
   proxy buffers SSE.
5. If you use voice transcription, start a recording and confirm the WebSocket
   upgrade succeeds.
6. Check the server log (component `HttpConfig`) for lines that say a proxy was
   loaded and for "SSL bypass not applied" warnings.

For a step-by-step proxy verification see [Verify the proxy](proxy-configuration.md#verify-the-proxy).

## See also

- [Proxy Configuration](proxy-configuration.md)
- [Self-Signed SSL Certificates](ssl-certificates.md)
- [Running with SSL/HTTPS](ssl-https-setup.md)
- [Production Reverse Proxy Guide](production-reverse-proxy-guide.md)
- [Security](security.md)
