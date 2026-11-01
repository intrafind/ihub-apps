# iFinder 1.0.0

- First version of the built-in iFinder definition. The installation `ifinder` holds the connection that used to live in `platform.iFinder`: base URL, sign-in (OIDC key pair or token exchange), endpoints, timeouts and the download directory.
- Seven actions keep their tool ids: `iFinder_search`, `iFinder_getContent`, `iFinder_getMetadata`, `iFinder_discover`, `iFinder_getFields`, `iFinder_getFacetValues`, `iFinder_listProfiles`. Every call runs as the signed-in user.
- Search profiles are install fields (default profile, allowed profiles, whether users may change it) and are offered as a scope the user picks per chat.
- Apps bind the installation under **Installed integrations** instead of listing tools.
