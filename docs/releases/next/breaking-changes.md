# Breaking Changes — Unreleased

## nginx Example Sends Its `server_name` to iHub as the Host

The example `docker/nginx.conf` no longer forwards the client's `Host` header to iHub. It sends
the configured `server_name` instead, so a request header can never become the Host iHub sees.

- The shipped `server_name localhost` makes iHub see `Host: localhost`.
- Sign-in return links, the OIDC logout redirect and the WebSocket origin check compare against that
  host, so a deployment on a real domain must set `server_name`.

**Before upgrading:** If you deploy this file, set `server_name` to your public hostname (including
the port when it is not 80 or 443).
