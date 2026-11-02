# Google Drive 1.0.0

- First version of the built-in Google Drive definition (`type: storage`). An installation holds one OAuth 2.0 client of a Google Cloud project: client id, the client secret as a credential reference, an optional redirect URI and the sources users may browse (My Drive, shared drives, shared with me).
- Install it as often as needed. The installation id is the provider id: it names the provider in the callback URL `/api/integrations/googledrive/<installation id>/callback` and in every user's stored connection.
- An empty redirect URI is derived from each request including the deployment's base path; the Settings tab shows the URL to register and copies it.
- Apps offer the provider in the chat's file picker by binding it (the installation, all Google Drive installations, or all storage providers); users see the providers their groups grant.
