# Running iHub Apps with SSL/HTTPS

This guide explains how to serve iHub Apps over HTTPS so that browsers and API
clients connect to it securely.

> **Scope.** This document is about **inbound** TLS — encrypting traffic
> _to_ iHub Apps. If instead you need iHub Apps to **trust an external
> service** that uses a self-signed certificate (a custom LLM endpoint, an
> internal API, an OIDC provider), see
> [SSL Certificates](ssl-certificates.md) instead.

## Two ways to serve over HTTPS

There are two supported approaches. Most production deployments should use a
reverse proxy.

| Approach | When to use | TLS handled by |
| -------- | ----------- | -------------- |
| **A. Reverse proxy (recommended)** | Production, multiple services, automatic certificate renewal (Let's Encrypt), subpath deployments | nginx / Apache / Traefik / Kubernetes Ingress |
| **B. Native HTTPS in Node** | Standalone binary, simple single-service setups, internal tools, local HTTPS testing | The iHub Apps Node.js server itself |

In both cases you should also set `USE_HTTPS=true` and configure
`ALLOWED_ORIGINS` — see [Settings required for any HTTPS deployment](#settings-required-for-any-https-deployment).

---

## Option A: Reverse proxy with TLS termination (recommended)

Here a reverse proxy terminates TLS and forwards plain HTTP to iHub Apps on its
internal port (default `3000`).

```
Browser ──HTTPS:443──▶  nginx / Apache / Traefik  ──HTTP:3000──▶  iHub Apps (Node)
                        (holds cert + key)                       (USE_HTTPS=true)
```

### How the backend detects HTTPS

iHub Apps trusts the first proxy hop (`app.set('trust proxy', 1)` in
`server/middleware/setup.js`) and resolves the public protocol from the
`X-Forwarded-Proto` header (`server/utils/publicBaseUrl.js`). Your proxy must
therefore forward these headers:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;   # http or https
proxy_set_header X-Forwarded-Prefix /ihub;    # only for subpath deployments
```

Without `X-Forwarded-Proto`, redirect URLs and OAuth/OIDC callbacks may be
built with the wrong scheme (`http://` instead of `https://`).

### Minimal nginx example

```nginx
upstream ihub_backend {
    server 127.0.0.1:3000;
}

# Redirect all HTTP to HTTPS
server {
    listen 80;
    server_name www.myserver.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name www.myserver.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://ihub_backend/;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for streaming chat (Server-Sent Events)
        proxy_buffering         off;
        proxy_request_buffering off;

        # Long timeouts for streaming LLM responses (15 min)
        proxy_connect_timeout 60s;
        proxy_send_timeout    900s;
        proxy_read_timeout    900s;
    }
}
```

The repository ships ready-to-use nginx templates:

- `nginx.conf` — local development example.
- `docker/nginx.conf` — production template that includes a commented-out
  `listen 443 ssl` block (uncomment and point it at your certificate files).

For subpath deployments (`https://www.myserver.com/ihub/`), Apache, Traefik
and Kubernetes Ingress examples, and full CORS details, see the
[Production Reverse Proxy Guide](production-reverse-proxy-guide.md).

### Start the backend

```bash
export ALLOWED_ORIGINS="https://www.myserver.com"
export USE_HTTPS=true
PORT=3000 npm run start:prod
```

---

## Option B: Native HTTPS in the Node server

The server starts in HTTPS mode automatically as soon as **both** `SSL_KEY` and
`SSL_CERT` are set (`server/server.js`). No code change is required.

### Environment variables

| Variable    | Required | Description |
| ----------- | -------- | ----------- |
| `SSL_KEY`   | Yes (for HTTPS) | Path to the PEM private key file |
| `SSL_CERT`  | Yes (for HTTPS) | Path to the PEM certificate file (include the full chain for CA-issued certs) |
| `SSL_CA`    | No | Path to an optional CA certificate |
| `PORT`      | No | Listen port (default `3000`; use `443` to serve standard HTTPS) |
| `HOST`      | No | Bind address (default `0.0.0.0`) |
| `USE_HTTPS` | Recommended | Set to `true` so authentication cookies get the `Secure` flag (see below) |

These are read from the process environment or a `.env` file in the project
root.

### Example `.env`

```bash
# Serve iHub Apps directly over HTTPS
SSL_KEY=/etc/ssl/private/ihub.key
SSL_CERT=/etc/ssl/certs/ihub-fullchain.crt
# SSL_CA=/etc/ssl/certs/ca-chain.crt   # optional

PORT=443
HOST=0.0.0.0
USE_HTTPS=true
ALLOWED_ORIGINS=https://www.myserver.com
```

> Binding to port `443` requires elevated privileges. Either run behind a proxy,
> grant the capability with `setcap 'cap_net_bind_service=+ep' $(which node)`,
> or use a high port (e.g. `3443`) and map it externally.

### Behavior and fallback

- HTTPS mode requires **both** `SSL_KEY` and `SSL_CERT`. With only one set, the
  server starts as plain HTTP.
- If the certificate files cannot be read (wrong path, bad permissions, invalid
  PEM), the server logs an error and **falls back to HTTP** rather than
  crashing. Always confirm the startup logs show HTTPS — see
  [Verifying the setup](#verifying-the-setup).
- iHub Apps does not auto-generate certificates; you must supply the files.

---

## Settings required for any HTTPS deployment

These apply to **both** Option A and Option B.

### 1. Enable secure cookies — `USE_HTTPS=true`

Session cookies (OIDC, OAuth integrations, local/LDAP login) only receive the
`Secure` attribute when `USE_HTTPS=true` (`server/middleware/setup.js`). Setting
this on any HTTPS deployment keeps auth cookies from ever being sent over plain
HTTP.

```bash
export USE_HTTPS=true
```

### 2. Allow your HTTPS origin — `ALLOWED_ORIGINS`

CORS origins are configured in `contents/config/platform.json`, which
references `${ALLOWED_ORIGINS}`. Set it to your public HTTPS URL(s):

```bash
# Single origin
export ALLOWED_ORIGINS="https://www.myserver.com"

# Multiple origins (comma-separated)
export ALLOWED_ORIGINS="https://www.myserver.com,https://admin.myserver.com"
```

### 3. Do not access the app via `http://0.0.0.0`

When the server binds to `0.0.0.0`, browse to `https://localhost`,
`https://127.0.0.1`, or your real hostname. Browsers reject cookies from
`0.0.0.0`, which breaks authentication.

---

## Generating certificates

### Self-signed certificate (development / internal only)

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ihub.key -out ihub.crt -days 365 \
  -subj "/CN=localhost"
```

Then point `SSL_KEY=ihub.key` and `SSL_CERT=ihub.crt` (Option B), or reference
them from your proxy (Option A). Browsers will warn about an untrusted
certificate — expected for self-signed certs.

### CA-issued / Let's Encrypt (production)

Obtain a certificate from a public CA or via Let's Encrypt (`certbot`). Use the
**full chain** (server certificate + intermediates) as `SSL_CERT` /
`ssl_certificate`. With a reverse proxy, tools like `certbot --nginx` can manage
issuance and renewal automatically — another reason Option A is preferred for
production.

---

## Docker

### Reverse proxy sidecar (recommended)

Run iHub Apps on its internal port and add an nginx service that terminates TLS.
Mount your certificates and the provided template:

```yaml
services:
  ihub-app:
    environment:
      - USE_HTTPS=true
      - ALLOWED_ORIGINS=https://www.myserver.com
    # internal only; not published to the host

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./docker/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - ihub-app
```

Uncomment the `listen 443 ssl` block in `docker/nginx.conf` and set
`ssl_certificate` / `ssl_certificate_key` to the mounted files.

### Native HTTPS in the container

Mount the certificate files and set the SSL variables:

```yaml
services:
  ihub-app:
    ports:
      - "443:3000"
    environment:
      - SSL_KEY=/certs/ihub.key
      - SSL_CERT=/certs/ihub-fullchain.crt
      - USE_HTTPS=true
      - ALLOWED_ORIGINS=https://www.myserver.com
    volumes:
      - ./certs:/certs:ro
```

---

## Verifying the setup

1. **Check the startup logs.** A correct HTTPS launch logs
   `Starting HTTPS server`. If you see `Starting HTTP server (no SSL
   configuration provided)` or `Falling back to HTTP server`, TLS is not
   active — re-check the variables and certificate paths.

   ```bash
   npm run logs
   ```

2. **Probe with curl.**

   ```bash
   # Native HTTPS with a self-signed cert (-k skips trust check)
   curl -kI https://localhost/api/health

   # Behind a reverse proxy
   curl -I https://www.myserver.com/api/health
   ```

3. **Test in a browser.** Open the site, confirm the padlock, and log in — a
   successful login confirms `Secure` cookies and CORS are correct.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| Server starts as HTTP despite SSL vars set | Both `SSL_KEY` **and** `SSL_CERT` must be set; check file paths and read permissions; review logs for `Falling back to HTTP server` |
| `EACCES` / permission denied on port 443 | Run behind a proxy, use `setcap` on the node binary, or bind a high port and map externally |
| Login works over HTTP but fails over HTTPS | Set `USE_HTTPS=true`; do not browse via `http://0.0.0.0` |
| CORS errors in the browser console | Add the exact HTTPS origin to `ALLOWED_ORIGINS` |
| Redirects/OAuth callbacks use `http://` behind a proxy | Ensure the proxy sends `X-Forwarded-Proto $scheme` |
| Streaming chat hangs or truncates behind a proxy | Disable proxy buffering and raise read/send timeouts (see the nginx example) |
| Browser warns about an untrusted certificate | Expected for self-signed certs; use a CA-issued certificate in production |

---

## Related documentation

- [Production Reverse Proxy Guide](production-reverse-proxy-guide.md) — full nginx/Apache/Traefik/Kubernetes setup, subpath deployment, CORS.
- [SSL Certificates](ssl-certificates.md) — trusting **external** services that use self-signed certificates (outbound).
- [Server Configuration](server-config.md) — all server environment variables.
- [Security Guide](security.md) — broader security hardening.
