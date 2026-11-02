# Microsoft Office 365 1.0.0 — breaking changes

Config migrations V200 and V205 moved the providers into installations:

- V200 moved the first enabled Office 365 provider of `platform.cloudStorage.providers[]` into the installation `office365` and removed the block. The tenant id is stored in the clear (it is an identifier, not a secret); a plain-text client secret went into the credential store.
- V205 renames the installation to the id the provider had before (so registered redirect URIs and the users' connections stay valid), installs the providers V200 parked in `config/cloudStorage.unmigrated.json` as further installations, and deletes the tenant id credentials left over in the credential store.
- The redirect URI derived from the request now includes the base path. A deployment under a sub-path (for example `/ihub`) that relied on the derived URL registers `https://<host>/ihub/api/integrations/office365/<installation id>/callback`. The `OFFICE365_OAUTH_REDIRECT_URI` environment variable is no longer read; set the redirect URI on the installation instead.
