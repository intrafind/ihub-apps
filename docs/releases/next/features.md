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

## vLLM Reasoning Budgets Answer Sooner

With **Limit reasoning in tokens** turned on, vLLM models now get much smaller reasoning budgets,
so answers start sooner. Models such as Qwen3.6 almost always think until the budget is spent, and
the old budgets were far above what the answers needed.

- Reasoning effort now sets: Minimal 256, Low 1,024, Medium 2,048, High 8,192 tokens (before: 512,
  2,048, 8,192 and 16,384). The levels are the same for every model.
- Without a reasoning effort, the Medium budget applies, the same level the request already used.
  Before, the reasoning could take 75% of the output limit.
- The budget never takes more than half of the output limit, so the answer always keeps the other
  half (before: a quarter).
- A model that needs more reasoning keeps working with an exact **Reasoning budget**
  (`thinking.budgetTokens`).
- Give the vLLM server a transition phrase in `--reasoning-config`. Without one, a model whose
  reasoning is cut off tends to continue it in the visible answer.
