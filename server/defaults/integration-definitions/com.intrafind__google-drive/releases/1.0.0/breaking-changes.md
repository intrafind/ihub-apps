# Google Drive 1.0.0 — breaking changes

Config migrations V200 and V206 moved the providers into installations:

- V200 moved the first enabled Google Drive provider of `platform.cloudStorage.providers[]` into the installation `googledrive` and removed the block; a plain-text client secret went into the credential store.
- V206 renames the installation to the id the provider had before (so registered redirect URIs and the users' connections stay valid) and installs the providers V200 parked in `config/cloudStorage.unmigrated.json` as further installations.
- The redirect URI derived from the request now includes the base path. A deployment under a sub-path (for example `/ihub`) that relied on the derived URL registers `https://<host>/ihub/api/integrations/googledrive/<installation id>/callback`. The `GOOGLEDRIVE_OAUTH_REDIRECT_URI` environment variable is no longer read; set the redirect URI on the installation instead.
