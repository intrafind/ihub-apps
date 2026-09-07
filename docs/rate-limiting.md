# Rate Limiting Implementation

This document describes the comprehensive rate limiting implementation added to protect the iHub Apps API endpoints.

## Overview

Rate limiting has been implemented using the `express-rate-limit` package to protect against abuse and ensure fair usage of API resources. The implementation includes configurable rate limiters with different restrictions for various endpoint types.

## Rate Limiting Types

The system supports six different types of rate limiters, each configurable through the platform configuration:

### 1. Public API Rate Limiter
- **Default Limit**: 500 requests per 1 minute per IP address
- **Applied to**: Regular API endpoints including:
  - `/api/apps`
  - `/api/tools` (including `/api/tools/:toolId`)
  - `/api/models`
  - `/api/prompts`
  - `/api/styles`
  - `/api/translations`
  - `/api/configs`
  - `/api/sessions`
  - `/api/pages`
  - `/api/magic-prompt`
  - `/api/short-links`

### 2. Admin API Rate Limiter
- **Default Limit**: 500 requests per 1 minute per IP address
- **Applied to**: Administrative endpoints:
  - `/api/admin/*` (all admin routes)

### 3. Auth API Rate Limiter
- **Limit**: 30 requests per 15 minutes per IP address in the shipped
  `platform.json` (`rateLimit.authApi.limit`). The code-level fallback, used only
  when no `rateLimit.authApi` section is present at all, is 50 per 15 minutes.
  Either way it is the most restrictive limiter.
- **Applied to**: Endpoints under `/api/auth` that verify credentials:
  - `POST /api/auth/local/login`
  - `POST /api/auth/ldap/login`
  - `GET|POST /api/auth/ntlm/login`
  - `POST /api/auth/teams/exchange`
  - `POST /api/auth/teams/config`
- **Not applied to** read-only endpoints in the same namespace. These are covered
  by the public API limiter instead:
  - `GET /api/auth/status` — fetched on every SPA boot and every 401 recovery,
    and commonly used as the container liveness/readiness probe
  - `GET /api/auth/user`
  - `GET /api/auth/oidc/providers`, `GET /api/auth/ldap/providers`,
    `GET /api/auth/ntlm/status`, `GET /api/auth/teams/client-config`
  - `GET /api/auth/oidc/:provider` and `GET /api/auth/oidc/:provider/callback` —
    the SSO redirect targets
  - `POST /api/auth/logout`

  The brute-force limiter is deliberately tight, so covering the whole namespace
  with it took the platform down instead of protecting it: a probe polling
  `/api/auth/status` exhausts a 30-per-15-minute window on its own, and from
  then on every caller — the probe included — gets `429` until the window
  resets. Only credential-verifying endpoints belong behind it.

  See also [`trustProxy`](#proxy-hops-and-the-rate-limit-key): if the hop count
  is too low, all callers share one counter and one busy client can exhaust the
  window for the whole deployment.

### 4. Inference API Rate Limiter
- **Default Limit**: 500 requests per 1 minute per IP address (moderate)
- **Applied to**: AI inference endpoints:
  - `/inference/*` (all inference routes)

### 5. Default Rate Limiter
- **Default Limit**: 500 requests per 1 minute per IP address
- **Purpose**: Base configuration that other limiters inherit from

### 6. OAuth API Rate Limiter
- **Default Limit**: 50 requests per 15 minutes per IP address (strict)
- **Applied to**: OAuth token and authorization endpoints:
  - `/api/oauth/*` (all OAuth routes)

## Configuration

Rate limiting is fully configurable through the `platform.json` configuration file. The built-in defaults are generous (500 req/min for most endpoints); add the `rateLimit` section to override them for your deployment. The example below shows a more restrictive configuration suitable for production:

```json
{
  "rateLimit": {
    "default": {
      "windowMs": 60000,
      "limit": 100,
      "standardHeaders": true,
      "legacyHeaders": false,
      "skipSuccessfulRequests": false,
      "skipFailedRequests": true
    },
    "adminApi": {
      "windowMs": 60000,
      "limit": 100,
      "skipFailedRequests": true
    },
    "publicApi": {
      "windowMs": 60000,
      "limit": 500,
      "skipFailedRequests": true
    },
    "authApi": {
      "windowMs": 900000,
      "limit": 30,
      "skipFailedRequests": false
    },
    "inferenceApi": {
      "windowMs": 60000,
      "limit": 500
    },
    "oauthApi": {
      "windowMs": 900000,
      "limit": 50,
      "skipFailedRequests": false
    }
  }
}
```

> **Note**: The `limit` values shown above are example overrides. The built-in defaults (500 req/min for most types, 50 req/15 min for auth/oauth) apply when no `rateLimit` section is present in `platform.json`.

### Configuration Options

Each rate limiter supports the following configuration options:

- `windowMs`: Time window in milliseconds (default: 60000 = 1 minute)
- `limit`: Maximum number of requests per window (varies by type)
- `standardHeaders`: Return rate limit info in `RateLimit-*` headers (default: true)
- `legacyHeaders`: Enable legacy `X-RateLimit-*` headers (default: false)
- `skipSuccessfulRequests`: Don't count successful requests (default: false)
- `skipFailedRequests`: Don't count failed requests (default: varies by type)
- `message`: Custom error message when limit exceeded

### Proxy hops and the rate-limit key

Every limiter counts per `req.ip`, and `req.ip` is derived from Express's
`trust proxy` setting — configured with `trustProxy` in `platform.json`:

```json
{
  "trustProxy": 2
}
```

The value is the number of proxy hops between the client and iHub. It also
accepts `true` / `false` or a comma-separated list of trusted addresses and
subnets (e.g. `"loopback, 10.0.0.0/8"`).

**Set this to the real hop count.** With the default `1` and two hops — an
ingress plus an internal load balancer, the usual Kubernetes layout —
`X-Forwarded-For` reads `client, ingress` and `req.ip` resolves to the *ingress*
address for every request. All users then share a single rate-limit counter, so
one busy client (or one OAuth/MCP handshake) can exhaust the auth or OAuth window
for the entire deployment.

Verify the resolved address with any endpoint that logs `ip` (see
[logging](logging.md)): if every request shows the same address while real
clients differ, the hop count is too low.

The same setting drives HTTPS detection via `X-Forwarded-Proto` — see
[SSL/HTTPS setup](ssl-https-setup.md).

### Inheritance

All rate limiters inherit from the `default` configuration. You only need to specify the options you want to override for each type. Empty configurations (`{}`) will use the default settings.

## Implementation Details

The rate limiters are implemented in `server/middleware/rateLimiting.js` using a factory pattern that creates configured limiters based on platform settings. They are applied in `server/middleware/setup.js` during application initialization.

### Features
- **Configurable Limits**: All parameters can be customized per endpoint type
- **Standard Headers**: Returns rate limit information in `RateLimit-*` headers
- **Smart Skipping**: Different behaviors for failed requests based on endpoint type
- **Clear Error Messages**: Provides helpful error messages when limits are exceeded
- **Sliding Window**: Uses a sliding window approach for fair distribution

## Response Headers

When rate limiting is active, the following headers are returned:

- `RateLimit-Policy`: Shows the policy (e.g., "100;w=900" for 100 requests per 900 seconds)
- `RateLimit-Limit`: Maximum number of requests allowed
- `RateLimit-Remaining`: Number of requests remaining in the current window
- `RateLimit-Reset`: Time in seconds until the rate limit resets

## Error Response

When rate limits are exceeded, a 429 status code is returned with a JSON error message:

```json
{
  "error": "Too many [type] requests from this IP, please try again later.",
  "retryAfter": "15 minutes"
}
```

## Testing

Rate limiting can be tested by making multiple requests to any protected endpoint:

```bash
# Test public API rate limiting
curl -I http://localhost:3000/api/apps

# Test admin API rate limiting
curl -I http://localhost:3000/api/admin/apps

# Test auth API rate limiting
curl -I http://localhost:3000/auth/login

# Test inference API rate limiting
curl -I http://localhost:3000/inference/chat
```

The response headers will show the current rate limit status.

## Security Impact

This implementation addresses GitHub security finding #217 by adding comprehensive, configurable rate limiting to all API endpoints, preventing abuse and ensuring the server remains available for legitimate users while allowing fine-tuned control over different endpoint types.
