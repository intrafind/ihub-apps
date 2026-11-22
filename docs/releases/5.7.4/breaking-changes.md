# Breaking Changes — 5.7.4

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

## Apps: IDs of the Form `uap_` Plus 32 Hex Characters Are Reserved

An app ID that consists of `uap_` followed by exactly 32 hexadecimal characters, for example
`uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8`, can no longer be given to an app that administrators
manage. iHub mints IDs of this form for personal apps. This applies whether or not the preview
feature **Personal apps** is switched on.

- **Admin → Apps**, `POST` and `PUT /api/admin/apps`, a Marketplace install and the example apps
  of an integration refuse such an ID with a validation error:

  > This ID is reserved for personal apps

- An ID that only starts with `uap_`, such as `uap_helper`, is still accepted.
- An existing app file with such an ID keeps loading and working. The server log shows a
  validation warning for it, and it can no longer be saved in the admin UI under that ID.

**Before upgrading:** Check `contents/apps/` for an app whose `id` has this form, for example
with `grep -lE '"id": *"uap_[a-f0-9]{32}"' contents/apps/*.json`. Give such an app another ID:
rename the file and its `id`, and replace the old ID in the `apps` lists of `groups.json`. Chats
and usage records keep the old ID. Installations without such an app need no action.
