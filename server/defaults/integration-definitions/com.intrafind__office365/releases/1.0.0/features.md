# Microsoft Office 365 1.0.0

- First version of the built-in Microsoft Office 365 definition (`type: storage`). An installation holds one Azure app registration: tenant id, client id, the client secret as a credential reference, an optional redirect URI, the sources users may browse (personal OneDrive, followed SharePoint sites, Teams) and optional site and drive restrictions.
- Install it as often as needed, for example once per tenant. The installation id is the provider id: it names the provider in the callback URL `/api/integrations/office365/<installation id>/callback` and in every user's stored connection.
- An empty redirect URI is derived from each request including the deployment's base path; the Settings tab shows the URL to register and copies it.
- Apps offer the provider in the chat's file picker by binding it (the installation, all Office 365 installations, or all storage providers); users see the providers their groups grant.
