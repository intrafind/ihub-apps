# Breaking Changes — Unreleased

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
