# Features — Unreleased

## Chats Send Far Less Data to the Browser

Chats that create documents, run searches or condense earlier results load and stream noticeably
less data. The browser now receives only what the chat displays, not the full content the model
wrote into a tool call.

- A generated file (PDF, Word, PowerPoint, Excel, code, ZIP) is stored with the chat as soon as the
  tool finishes. The chat shows its card right away and loads the file only when it is opened or
  downloaded; before, the whole file was streamed into the chat.
- The details of a tool call show each value cut to 160 characters. The full Markdown of a PDF, the
  slides of a presentation or the HTML of a web page are no longer sent along with it.
- The notes of a condensed search show the facts found and what was not found. The instructions
  meant for the model and the repeated list of calls are left out, and the notes are cut at 2,000
  characters.
- Sources found by several searches are sent only once when a chat is opened.
- The `/v1` APIs and the run log still receive the full data.
