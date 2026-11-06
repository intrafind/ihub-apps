# iFinder 1.2.0

- Documents by reference: the integration now hands over a document by its id (`files` capability), with the signed-in user's own iFinder permissions. A link such as `/apps?documentId=<id>&integration=ifinder` opens the app list with the document waiting; the app you choose receives it as the original file (an image as an image).
- Only apps that bind iFinder are offered (the binding is what lets an app receive the document, whatever its local upload settings are). An app that does not bind the integration never receives an iFinder document.
- The document is a resource of the integration: `GET /api/integrations/ifinder/files` (is it available to me), `/files/{id}` (details), `/files/{id}/content` and `/files/{id}/content/{filename}`. The id is a URL-encoded path segment; the search profile is `?scope=`. They answer `404` when iFinder is not installed or configured and `403` when the user's groups do not grant it.
- No change to the settings, the action names or their input; installations move to 1.2.0 without a migration and no action shows as changed.
