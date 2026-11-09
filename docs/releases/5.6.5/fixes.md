# Fixes — 5.6.5

## Base Path Installations: Chats Started From the Start Page Open in the App

On an installation under a base path (for example `/ihub`), sending a message from the start page's
chat input led to `/ihub/ihub/apps/<app>`, a page that does not exist, instead of the app's chat.
The same happened when a link opened an app with settings in the address (`?model=`, `?style=`,
`?var_…`) or with a document ("Open in App"). The chat now opens in the app and the message is
sent.

## Chat Input: The Upload Button Shows for Apps With Web Search

On a desktop, an app whose only quick action was file upload (no magic prompt, no microphone)
showed no paper clip when it also offered web search; turning on magic prompt made it appear. The
browser extension's side panel, with its "Include page" option, had the same problem when opened
wide. The paper clip now shows in both cases.

## Base Path Installations: The Logo Shows When Its URL Holds the Base Path

On an installation under a base path (for example `/ihub`), a header logo URL that already started
with the base path (`/ihub/uploads/assets/logo.png`, the address the browser shows) was requested as
`/ihub/ihub/…`, so the logo in the sidebar, the header, the start page and the sign-in screen did
not load behind a reverse proxy that forwards the prefix. Such URLs are now used as they are, as
are `data:image/…` logos, which were not shown on any installation. `/uploads/assets/logo.png`
keeps working as before.
