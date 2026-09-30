# Fixes — Unreleased

## The Answer Badge Says "Based on AI Knowledge" Only When It Is

A transcript of a recording or an uploaded audio or video file was labelled "Based on AI knowledge"
— although the text comes straight from the user's own audio — and so was anything else the chat
could not place: a question the assistant asked back, a notice, an answer whose run was cut off.
The server now names what every answer is based on, and the badge shows exactly that. A transcript
reads "Based on audio recording".

- Applies to transcripts from the transcription model (upload, video and microphone recording),
  including a partial transcript kept after a cancelled or interrupted run.
- Also applies when audio is sent directly to a chat model that accepts it, such as the
  **Audio Transcription** app.
- An answer stopped with **Stop** keeps the badge of what it had used until then.
- Questions the assistant asks back, notices, failed answers and answers whose run was interrupted
  show no badge. A failed transcription still shows the error message without a badge.
- Answers stored before this release show no badge: nothing recorded what they were based on.

## Admins' Own Chats Clear Their "New" Badge When Opened

For admins, a chat answered while they were away kept its "new" dot in **Recents** and the chat
list even after they opened it. The server treated an admin reading their own chat like an admin
reading somebody else's, which deliberately leaves the badge alone. It now checks ownership first.
Opening another user's chat as an admin still leaves that user's badge untouched.

## vLLM Models Return Structured Answers Again When "Show Reasoning" Is Off

On vLLM models with thinking enabled and **Show reasoning** turned off, every request that asks
for a structured (JSON) answer came back empty. Workflows stopped extracting anything — each
document failed with:

> [NO_EXTRACTION_OUTPUT] Upstream prompt produced no output

vLLM returns no content when hidden reasoning is combined with structured output. For structured
requests iHub no longer asks vLLM to hide the reasoning, so apps with structured output can show
the model's reasoning even when **Show reasoning** is off.

## Azure Speech Dictation Works Again

Dictation with Azure Speech put no text into the chat input. The subscription key set under
**Admin → Voice Input** was also never used: an app without a host of its own failed with "Azure
subscription key is not configured".

- The recognized text is delivered to the input again, in both manual and automatic mode.
- The subscription key stored on the server is used (as a short-lived token), and apps without
  a host of their own fall back to the host set under **Admin → Voice Input**, as documented.
- A "no speech detected" error no longer leaves the microphone in the listening state.

## Admin → Voice Input Confirms a Save

Saving on **Admin → Voice Input** showed no confirmation, and the page briefly went blank while
reloading. It now stays in place and shows "Voice input settings saved."

## OpenAI Web Search Answers Show Their Sources

Streamed answers from OpenAI models with native web search showed no sources, and their badge
said **Based on AI knowledge**. The citations of a streamed answer are now read, so the answer
lists its sources and carries the web search badge.

## `@workflow` Chats Appear in the Chat History While They Run

A chat that started a workflow with `@workflow` (for example `@stellungnahmen-review`) was missing
from **Recents** and the chat list until the workflow finished — and never appeared at all if the
user left the chat while it ran, until the page was reloaded. The list now updates as soon as any
turn starts, and a chat that is still working on an answer is marked **Running**.

- Such chats are named after the question, not after the mention (`@stellungnahmen-review Q3` is
  titled "Q3"; a bare mention is titled after the workflow).
- A workflow that fails to start no longer leaves the chat spinning; the error is shown.

## Chats Interrupted by a Server Restart No Longer Stay "Running"

A chat whose answer was being produced when the server stopped — a long workflow is the usual case
— stayed marked as running forever, and opening it showed a spinner that never ended. When such a
chat is listed or opened, it is now closed with an answer that says it was interrupted, together
with the searches and tool calls the run had made up to then. The run's audit ledger records the
interruption too.

- A workflow started with `@workflow` is closed by what its execution says: one waiting at a human
  checkpoint shows **Waiting for your input** with a link to continue it on its execution page; a
  finished one delivers its answer to the chat. Once a waiting workflow is continued and finishes,
  its answer replaces **Waiting for your input** the next time the chat is opened.
- Workflows started from a chat that were running at the restart are marked failed in
  **My Executions** instead of staying "running".

## Chat with Results Works With Durable Chats

**Chat with Results** on a workflow execution opened an empty chat when **Durable Chats** is on:
the execution's results never reached it. The server now creates the chat from the execution
itself, with its input as the question and its output as the answer, linked to the execution.

## `@workflow` Only Starts Workflows the App Lists and the User May Run

A user could start any chat-enabled workflow by typing `@<workflow-id>` in any chat — also one
their groups do not grant, or one the app does not offer. The server now applies the same rule as
the workflow picker: the app lists the workflow under **Workflows**, and the user's groups grant
it. A workflow the user may not run is treated as ordinary text; one the app does not list is
refused with "not available in this app".

- If users started workflows by typing the mention in an app that does not list them, add the
  workflows to that app.

## Admin → Prompts → Variables Saves Again

Saving on the **Variables** tab of **Admin → Prompts** failed with "Request failed with status
code 404", so changes to the global context and new, edited or deleted custom variables were
lost. The tab now saves, and the saved context and variables are used in prompts right away.
