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
  
## Voice Mode Now Stays in the Chat

Voice mode no longer covers the conversation with a full-screen view. It works like ChatGPT and
Claude: the chat stays visible and scrollable, and every turn lands in it as a normal message
while you talk, with its sources and links.

- The input field turns into a voice dock. It shows the state (*Listening…*, *Thinking…*, the
  running tool, *Speaking…*) and your words as you speak, with level bars and a soft glow in the
  colour of the state.
- One set of controls: **Stop** cuts the answer short, the microphone button mutes, **Hold to
  talk** appears in push-to-talk mode, and **End** (or **Esc**) brings the input field back. The
  settings open upwards from the dock.
- The answer is marked in the chat message itself as it is read out: the part still to come is
  grey. The setting that was called **Show captions** is now **Show live transcript**.
- The dock stays a text field, like Claude's: a typed message joins the conversation and is
  answered out loud. It stops an answer that is still running.
- Messages cannot be edited while voice mode is on.
- **Try it** under **Admin → Voice Input** uses the same dock, with the conversation above it.
