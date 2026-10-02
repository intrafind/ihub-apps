# Breaking Changes — Unreleased

## Anonymous Access: Group Permissions Apply to Every Request

Requests without a sign-in are now checked against the permissions of the groups in
`anonymousAuth.defaultGroups` on every endpoint, including the OpenAI-compatible inference API
(`/api/inference/v1`), app and model details, the model test and Magic Prompt. Visitors who are
not signed in can only use the apps and models those groups grant.

- `GET /api/apps/{appId}` and `GET /api/models/{modelId}` answer `404` for an app or model the
  caller may not use, signed in or not — the same answer as for one that does not exist.
- Magic Prompt takes its instruction and model from the app's `features.magicPrompt` settings;
  requests without an app, or for an app without that section, use `MAGIC_PROMPT_PROMPT` and
  `MAGIC_PROMPT_MODEL`. A `prompt` sent with the request is ignored. A requested model is used if
  the caller may use it; otherwise the request is answered with `403`.
- Magic Prompt requests count against the general API rate limit.
- Starting an OCR job (`POST /api/tools-service/ocr/process`) needs a sign-in.
- Anonymous users never have admin or content-admin access, even when one of their default groups
  grants it.

**Before upgrading:** if visitors who are not signed in use the inference API or Magic Prompt,
check that the anonymous group in `groups.json` grants the apps and models they need. Scripts that
send their own `prompt` to `/api/magic-prompt` need that instruction in the app's
`features.magicPrompt.prompt` (or in `MAGIC_PROMPT_PROMPT`) instead.

## Apps: Links Must Use http or https, and Invalid App Configurations Are Not Saved

Redirect apps open, and iframe apps embed, only addresses that start with `http://` or
`https://`. A redirect or iframe app with any other kind of link (for example `mailto:`) shows an
error instead of opening or embedding it.

Creating or saving an app — under **Admin → Apps**, with the app creation wizard, by uploading an
app file or through the admin API — now checks the complete configuration against the app schema.
A configuration that does not pass is not saved, and the admin sees a validation error naming the
field, for example:

> Invalid app configuration: redirectConfig.url: Redirect URL must use http or https

- App files already on the server keep loading as before. One that does not pass is reported in
  the server log ("Resource validation issues") and has to be corrected before it can be saved
  again.
- Apps created with the app creation wizard in earlier releases contained the fields `useAI`,
  `useTemplate`, `useManual`, `aiGenerated`, `aiPrompt`, a top-level `imageUpload` and
  `"parentId": null`. They have no effect, and the upgrade removes them from the app files on the
  server, so these apps can be saved as before.

**Before upgrading:** Change redirect and iframe apps whose URL does not start with `http://` or
`https://`. App files uploaded under **Admin → Apps** and scripts that create or update apps
through the admin API must send configurations that pass validation; fields that are not part of
an app configuration are rejected.

## Short Links Belong to Their Creator and Redirect Only to Allowed Targets

Short links now have an owner: the signed-in user who creates one. Only that user and
administrators can list, change or delete it, and creating a link needs a sign-in — visitors who
are not signed in no longer see **Link to the app** in the share dialog.

- A link redirects to a path on this server, or to an absolute `http`/`https` URL whose host is
  allowed by `shortLinks.allowedHosts` in `platform.json` (empty by default) — an exact
  hostname, a subdomain pattern such as `*.example.com`, or a `/regex/`. The target is
  checked when a link is saved and again every time it is opened; a link whose target is not
  allowed answers "Not found".
- **Admin → Short Links** shows each link's owner. Links saved before this release have no owner
  and can be changed or deleted by administrators only.
- The general API rate limit now applies to `/api/shortlinks`.

**Before upgrading:** if short links point to absolute URLs — including full URLs of this
installation — add their hosts to `shortLinks.allowedHosts`, or change the links to paths such as
`/apps/chat`.

## Subpath Deployments: X-Forwarded-Prefix Is Used Only From Trusted Proxies

The base path a reverse proxy sends in `X-Forwarded-Prefix` (or the header named by
`BASE_PATH_HEADER`) is now used only when the request comes from a proxy that `trustProxy` in
`platform.json` trusts. It is also applied before the rate limiters, so requests sent under a base
path count against the same limits as all others — before, they were not limited at all.

- With a hop count such as the default `1`, any peer counts as trusted, so most subpath
  deployments keep working unchanged.
- With `"trustProxy": false`, the header is ignored.
- With a list of addresses, the header is used only from those addresses.

**Before upgrading:** if iHub runs under a subpath (for example `/ihub`) and `trustProxy` is `false`
or a list of addresses, make sure it trusts the proxy that sets `X-Forwarded-Prefix` — for example
`"trustProxy": "loopback"` when the proxy runs on the same host. Otherwise the app no longer finds
its base path.

## Proxy Authentication: Identity Headers Are Accepted Only From Trusted Proxies

With proxy authentication on, iHub now takes the user, groups, name and email from the proxy
headers (`X-Forwarded-User`, `X-Forwarded-Groups`, `X-Forwarded-Name`, `X-Forwarded-Email`, or the
names configured for user and groups) only when the request comes through a proxy you trust.
Other requests are handled as if the headers were not there, and the server log notes that they
were ignored.

- `proxyAuth.trustedProxies` in `platform.json` (or `PROXY_AUTH_TRUSTED_PROXIES`, a
  comma-separated list) lists the addresses the connection must come from: `loopback`, single
  addresses such as `10.0.0.5`, or subnets such as `10.0.0.0/8`. It defaults to `["loopback"]` in
  new installations and after the upgrade, so a proxy on the same host or in the same pod works as
  soon as proxy authentication is on.
- Instead of, or in addition to, the address list, the proxy can send a shared secret in the
  header `proxyAuth.sharedSecretHeader` (default `X-Proxy-Secret`). The secret is a **Secret**
  credential chosen in `proxyAuth.sharedSecretRef`, or the value of `PROXY_AUTH_SHARED_SECRET`.
  When both are set, a request must pass both — to rely on the secret alone, empty the address
  list. The secret header is removed from the request after the check, so it cannot be a header
  sign-in needs (such as `Authorization` or an `X-Forwarded-*` header). If the chosen credential is
  missing or empty, no request is trusted.
- With neither set, the headers are ignored. **Admin → Authentication** has fields for both and
  shows a warning in the proxy authentication settings while both are empty.
- `GET /api/auth/status` only says whether proxy authentication is on; it no longer lists the
  header names.
- Signed tokens from `proxyAuth.jwtProviders` are verified as before.

**Before upgrading:** if proxy authentication is on and the proxy runs on another host or in
another container, add its address or subnet to `proxyAuth.trustedProxies`, or configure a shared
secret, have the proxy send it and empty the address list. If other processes on the same host or
in the same pod forward traffic to iHub over loopback (for example a service-mesh sidecar),
configure the shared secret as well. The proxy should set the identity headers itself and drop any
values the client sent.

## Docker Quickstart and Development Setups Listen on 127.0.0.1 Only

`docker-compose.quickstart.yml` and `docker/docker-compose.yml` now publish their ports (3000, and
5173 for the development setup) on `127.0.0.1` only, so the app is reachable from the machine it
runs on and not from the network. `docker/docker-compose.prod.yml` is unchanged.

- With Docker Engine older than 28.0.0, other hosts on the same local network segment can still
  reach ports published on `127.0.0.1`. Update the engine, or block the ports in the host
  firewall.

**Before upgrading:** if you open a quickstart or development setup from another machine, put a
reverse proxy in front of it, or change the binding back to `'3000:3000'` once the passwords of
the shipped accounts have been changed.

## Workflows: The Code Node Is Removed

Workflows can no longer contain **Code** nodes, which ran a JavaScript snippet on the server. The
node is gone from the workflow editor, a workflow that contains one cannot be saved, and a run that
reaches one stops with an error naming the node type.

- The shipped **Corpus Completeness Analysis — Decomposed** workflows (both versions) used a code
  node to collect the documents found for each sub-question. They now use a transform node, and
  the upgrade changes installed copies the same way, unless that code node was edited.
- Transform nodes have a new **Append All** operation (`{ "append": "_corpus", "to": "_corpusAll" }`)
  that adds every item of one array to another — what most code nodes were used for.

**Before upgrading:** check your own workflows for code nodes; the server log lists the workflows
that still contain one after the upgrade. Replace each with transform operations, or with a prompt
node where the step needs more than moving data around.
