# Server Configuration

This section covers environment variables and options for running the AI Hub Apps server.

## Environment Variables

The server reads settings from the environment or a `.env` file such as `config.env`.

| Variable                   | Description                                                       | Default                                          |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `PORT`                     | Port the HTTP server listens on                                   | `3000`                                           |
| `HOST`                     | Host interface to bind to                                         | `0.0.0.0`                                        |
| `REQUEST_TIMEOUT`          | LLM request timeout in milliseconds                               | `60000`                                          |
| `WORKERS`                  | Number of Node.js cluster workers                                 | CPU count                                        |
| `OPENAI_API_KEY`           | API key for OpenAI models                                         | –                                                |
| `ANTHROPIC_API_KEY`        | API key for Anthropic models                                      | –                                                |
| `MISTRAL_API_KEY`          | API key for Mistral models                                        | –                                                |
| `GOOGLE_API_KEY`           | API key for Google models                                         | –                                                |
| `DEFAULT_API_KEY`          | Fallback API key used when a model specific key is missing        | –                                                |
| `LOCAL_API_KEY`            | Generic API key for local models                                  | –                                                |
| `CONTENTS_DIR`             | Directory containing the `contents` folder                        | `contents`                                       |
| `APP_ROOT_DIR`             | Override the application root path when running packaged binaries | –                                                |
| `MCP_SERVER_URL`           | URL of a Model Context Protocol server for tool discovery         | –                                                |
| `BRAVE_SEARCH_API_KEY`     | API key for the Brave Search tool                                 | –                                                |
| `BRAVE_SEARCH_ENDPOINT`    | Custom Brave Search API endpoint                                  | `https://api.search.brave.com/res/v1/web/search` |
| `TAVILY_SEARCH_API_KEY`    | API key for the Tavily Search tool                                | –                                                |
| `TAVILY_ENDPOINT`          | Custom Tavily API endpoint                                        | `https://api.tavily.com/search`                  |
| `MAGIC_PROMPT_MODEL`       | Default model for the magic prompt feature                        | `gpt-3.5-turbo`                                  |
| `MAGIC_PROMPT_PROMPT`      | Default prompt used to refine user input                          | `Improve the following prompt.`                  |
| `AUTH_MODE`                | Login flow (`proxy`, `local`, `oidc`)                             | `proxy`                                          |
| `PROXY_AUTH_ENABLED`       | Enable proxy authentication mode                                  | `false`                                          |
| `PROXY_AUTH_USER_HEADER`   | Header containing the authenticated user ID                       | `X-Forwarded-User`                               |
| `PROXY_AUTH_GROUPS_HEADER` | Optional header with comma separated group names                  | –                                                |
| `PROXY_AUTH_JWKS`          | JSON Web Key Set URL for verifying forwarded JWTs                 | –                                                |
| `PROXY_AUTH_JWT_HEADER`    | Header containing the JWT if not using `Authorization`            | `Authorization`                                  |

The concurrency of outbound requests is configured via `requestConcurrency` in `contents/config/platform.json` and can be overridden per model or tool. If this value is omitted or below `1`, requests are not throttled.
The delay between requests can be adjusted with `requestDelayMs` in the same configuration files. A value of `0` disables the delay.

### Example: Enabling Proxy Authentication

Add a `proxyAuth` section to `platform.json`:

```json
{
  "proxyAuth": {
    "enabled": true,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "jwtProviders": [
      {
        "header": "Authorization",
        "issuer": "https://login.example.com/",
        "audience": "ai-hub-apps",
        "jwkUrl": "https://login.example.com/.well-known/jwks.json"
      }
    ]
  }
}
```

### OpenAI-Compatible Proxy

The server exposes configured models via an OpenAI compatible API. It reuses the same authentication mechanism as the rest of the application (`proxy`, `local`, `jwt`, or `oidc`).

Authenticated requests can call `/api/inference/v1/chat/completions` and `/api/inference/v1/models` using any OpenAI compatible client. Model access is filtered based on the user's permissions.

## SSL Configuration

To enable HTTPS you must provide certificate files via environment variables:

| Variable   | Description                        |
| ---------- | ---------------------------------- |
| `SSL_KEY`  | Path to the private key file       |
| `SSL_CERT` | Path to the certificate file       |
| `SSL_CA`   | Path to an optional CA certificate |

When `SSL_KEY` and `SSL_CERT` are set the server starts in HTTPS mode.

### External Services with Self-Signed Certificates

If AI Hub Apps needs to communicate with external services using self-signed SSL certificates (such as custom LLM endpoints, internal APIs, or authentication providers), see the [SSL Certificates Guide](ssl-certificates.md) for configuration options.

## Example

Run the production build with four workers on port 8080:

```bash
PORT=8080 HOST=127.0.0.1 WORKERS=4 npm run start:prod
```
