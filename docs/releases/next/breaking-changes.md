# Breaking Changes — Unreleased

## nginx Example Sends Its `server_name` to iHub as the Host

The example `docker/nginx.conf` no longer forwards the client's `Host` header to iHub. It sends
the configured `server_name` as both `Host` and `X-Forwarded-Host`, replacing any value the client
sent, so a request header can never become the host iHub sees.

- The shipped `server_name localhost` makes iHub see `localhost`.
- Sign-in return links, the OIDC logout redirect (which reads `X-Forwarded-Host` before `Host`
  unless `postLogoutRedirectURL` is set) and the WebSocket origin check compare against that host,
  so a deployment on a real domain must set `server_name`.

**Before upgrading:** If you deploy this file, set `server_name` to your public hostname. nginx
matches `server_name` without the port, so for a public port other than 80 or 443 keep the
hostname there and replace `$server_name` in the two `proxy_set_header` lines (`Host` and
`X-Forwarded-Host`) with a literal such as `example.com:8443`.
