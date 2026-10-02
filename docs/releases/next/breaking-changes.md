# Breaking Changes — Unreleased

## Anonymous Access: Group Permissions Apply to Every Request

Requests without a sign-in are now checked against the permissions of the groups in
`anonymousAuth.defaultGroups` on every endpoint, including the OpenAI-compatible inference API
(`/api/inference/v1`), app and model details, the model test and Magic Prompt. Visitors who are
not signed in can only use the apps and models those groups grant.

- `GET /api/apps/{appId}` and `GET /api/models/{modelId}` answer `404` for an app or model the
  caller may not use, signed in or not — the same answer as for one that does not exist.
- Magic Prompt takes its instruction and model from the app's `features.magicPrompt` settings. A
  `prompt` sent with the request is ignored, and a requested model must be one the caller may use.
- Magic Prompt requests count against the general API rate limit.
- Anonymous users never have admin or content-admin access, even when one of their default groups
  grants it.

**Before upgrading:** if visitors who are not signed in use the inference API or Magic Prompt,
check that the anonymous group in `groups.json` grants the apps and models they need. Scripts that
send their own `prompt` to `/api/magic-prompt` need an app with that instruction configured
instead.

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
