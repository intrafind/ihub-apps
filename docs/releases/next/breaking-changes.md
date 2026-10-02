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
