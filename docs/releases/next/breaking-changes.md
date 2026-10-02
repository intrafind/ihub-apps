# Breaking Changes — Unreleased

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
