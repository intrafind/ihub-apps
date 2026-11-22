# Features — Unreleased

## Chats Send Far Less Data to the Browser

Chats that create documents, run searches or condense earlier results load and stream noticeably
less data. The browser now receives only what the chat displays, not the full content the model
wrote into a tool call.

- A generated file (PDF, Word, PowerPoint, Excel, code, ZIP) is stored with the chat as soon as the
  tool finishes. The chat shows its card right away and loads the file only when it is opened or
  downloaded; before, the whole file was streamed into the chat. A file that cannot be stored — in
  a chat that is not stored, with artifacts turned off, or over the artifact size limit — is still
  sent with its card, so it stays downloadable while the page is open.
- The details of a tool call show each value cut to 160 characters. The full Markdown of a PDF, the
  slides of a presentation or the HTML of a web page are no longer sent along with it. Search
  queries, links and document ids stay complete, and an interactive MCP App view still receives
  its whole input.
- The notes of a condensed search show the facts found and what was not found. The instructions
  meant for the model and the repeated list of calls are left out, and the notes are cut at 2,000
  characters.
- Sources found by several searches are sent only once when a chat is opened.
- The `/v1` APIs and the run log still receive the full data.

## Read-Only Tool Calls Run Side by Side (Preview)

When a model asks for several tool calls in one step and all of them only read, a chat can now
run them at the same time instead of one after the other. Three web searches in one step take
about as long as the slowest of them. The feature is a preview and off by default: turn it on under
**Admin → Features → Read-only tool calls side by side**.

- It applies to answers in a chat, to the runs of scheduled tasks and to apps that are called as
  a tool. Workflow steps keep their own setting.
- Up to four calls run at once. A step that holds a call which changes something, asks the user a
  question or needs an approval runs one call at a time, in the order the model asked for them, as
  before.
- A call counts as read-only only when a trusted source says so: the tool itself, the definition
  of its integration, or an admin on the action (**Admin → Integrations** → the installation → the
  action → **Side effect**). What a remote MCP server says about its own tools does not count, and
  neither does an action without a declared side effect. Such calls keep running one at a time
  until an admin sets the side effect of the action to **read**.
- The model receives the results in the order of its calls, whichever call finishes first, and the
  chat lists the calls in that order, also after a reload.
- A tool's own limit still applies: a search engine that allows one request at a time handles the
  searches of a step one by one.
- A model can be excluded: clear **Read-only tool calls side by side** in the model's settings
  (`"parallelToolCalls": false` in the model file). Its chats then run every call alone.
- Every tool iHub ships now declares whether it reads or changes something. Under the approval
  mode **Ask unless it only reads** (`writes`), iHub's own read tools that declared nothing before
  are no longer asked for: the project knowledge tools (`knowledge_search`, `knowledge_read`,
  `knowledge_list`), `read_memory`, `read_inbox`, `list_tasks`, `evidence_collect`,
  `evidence_validateQuotesFastPath` and `preview_pdf`. Tools that change something are asked for
  as before. Use the mode **Always ask** where these reads should still be confirmed.
