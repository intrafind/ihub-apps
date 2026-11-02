# Nextcloud 1.0.0

- First version of the built-in Nextcloud definition (`type: storage`). An installation holds one Nextcloud server: its URL, the OAuth 2.0 client registered in Nextcloud (client id, the client secret as a credential reference) and an optional redirect URI.
- Install it once per Nextcloud server. The installation id is the provider id: it names the provider in the callback URL `/api/integrations/nextcloud/<installation id>/callback`, in every user's stored connection and in the Nextcloud embed plugin's `ihub_provider_id`.
- An empty redirect URI is derived from each request including the deployment's base path; the Settings tab shows the URL to register and copies it.
- Apps offer the provider in the chat's file picker by binding it (the installation, all Nextcloud installations, or all storage providers); users see the providers their groups grant.
