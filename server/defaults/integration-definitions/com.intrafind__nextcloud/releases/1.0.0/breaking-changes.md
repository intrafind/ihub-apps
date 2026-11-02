# Nextcloud 1.0.0 — breaking changes

Config migrations V200 and V206 moved the providers into installations:

- V200 moved the first enabled Nextcloud provider of `platform.cloudStorage.providers[]` into the installation `nextcloud` and removed the block; a plain-text client secret went into the credential store.
- V206 renames the installation to the id the provider had before (so registered redirect URIs, the users' connections and the embed plugin's `ihub_provider_id` stay valid) and installs the providers V200 parked in `config/cloudStorage.unmigrated.json` as further installations — a second Nextcloud server works again.
- The redirect URI derived from the request now includes the base path. A deployment under a sub-path (for example `/ihub`) that relied on the derived URL registers `https://<host>/ihub/api/integrations/nextcloud/<installation id>/callback` in Nextcloud. The `NEXTCLOUD_OAUTH_REDIRECT_URI` environment variable is no longer read; set the redirect URI on the installation instead.
