# Features — Unreleased

## Faster App Startup

The app now opens noticeably faster, most of all on slower connections. The start page used to
download about 12 MB; it now loads about 1 MB.

- Diagram rendering, PDF reading, the Teams SDK, the Azure Speech SDK and the token counter are
  no longer part of the initial load. Each one loads the first time it is actually needed — for
  example, diagram support when the first Mermaid diagram appears in a chat.
- UI translations are loaded from the server for the selected language only instead of being
  built into the app for every language.
- The server now compresses its responses (gzip or Brotli). Admins whose reverse proxy already
  compresses need to change nothing: the proxy passes compressed responses through.
- Browsers keep the app's script and style files cached after the first visit and no longer ask
  the server about them on every page load. A new release still loads immediately, as its files
  have new names.
