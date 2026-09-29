# Fixes — Unreleased

## Reasoning models: no more silent empty answers

A reasoning model spends its thinking tokens from the same output limit as the answer. When a long
thought used the whole limit, the chat showed the thinking and then nothing, with no hint why.

- A message that stopped at the output limit now carries a **Truncated** label. Hovering it explains
  the cause and the fix.
- Output limits are higher: the fallback for a model without a **Max Output Tokens** value is now
  16384 (was 4096, and never more than half the context window), and the bundled Claude Haiku
  4.5 (64000), Mistral (32000) and Local vLLM (16000) models ship with more room. Installed copies
  that still have the old bundled value are raised automatically; values you set yourself are
  kept.
- The **Max Output Tokens** field in the model form shows the default as a placeholder and says
  that an empty field means the default, not unlimited.
- The thinking behind **Show thinking** is split into separate steps at each blank line instead of
  one long block of text.
- The bundled **Local vLLM** model now uses the `local` provider, which sends the reasoning
  settings vLLM understands (`chat_template_kwargs`, `include_reasoning`). Existing model files are
  not changed; set `"provider": "local"` on a vLLM model to get the same.
  
## Reopened chats show your message when you only uploaded a file

In apps like the NDA Risk Analyzer, you can upload a document and send it without typing anything.
When you reopened such a chat from history, your message was missing and only the answer was
shown. The message now appears again, showing the name of the file you sent.

- Messages where you typed text and attached a file now also show the file name after reopening.
- The file itself is not stored with the chat, so only its name is shown.

## vLLM models respect "Show reasoning" being turned off

On vLLM models (`provider: "local"`), turning off "Show reasoning" in the model settings, or
"Show thinking process" in an app or chat, had no effect: the model's reasoning was still shown.
The model still reasons, but its reasoning text is no longer returned or shown.

- The model setting is the default; an app's thinking settings and the user's toggle override it.
- Needs a vLLM version that supports `include_reasoning`. Older servers ignore it and keep
  showing the reasoning.

## Tools always run as the signed-in user

A direct tool call (`POST /api/tools/<toolId>`) could name another user in its request body, and
tools that act as the caller, such as iFinder, Jira or MCP servers with per-user sign-in, then
ran with that user's identity and access. Tool calls now always run as the signed-in user; user
and chat details in the request body are ignored.

- The same applies to workflows and tools started through the MCP gateway and the A2A endpoint.

## Group tool grants by server or tool family apply to the tool list

A group that granted an MCP server id or a tool family (for example `iFinder` for all
`iFinder_*` tools) did not see those tools in the chat's tool list, although the MCP gateway
already honoured the grant. The tool list now reads group grants the same way as app tool
settings: an exact tool id, a tool family, or an MCP server id.

## Outlook Add-in: copy options menu no longer opens off-screen

In the narrow Outlook task pane, the copy options menu under an assistant answer ("as Text",
"as Markdown", "as HTML") opened to the left of the pane and was cut off, so the copy formats could
not be reached. The menu now opens to the right, inside the pane.

- Applies to every chat view that shows assistant messages, not just the Outlook add-in.
- Menus under your own messages still open to the left, as those are right-aligned.

## Outlook Add-in: Edit Message Form Stays Inside the Message Bubble

In the Outlook add-in task pane, choosing Edit on one of your messages showed the edit box sticking
out past the right edge of the message bubble instead of sitting inside it. The edit box and its
Cancel and Send buttons now stay inside the bubble at every pane width.

- The browser extension and Nextcloud integration use the same styling and get the same fix.
- The main web app was not affected.

## iAssistant Documents Come Back When a Chat Is Reopened

The **Documents** panel under an iAssistant answer disappeared when a stored chat was reopened from
the chat history. The documents are now stored with the answer and the panel comes back with it.
When an iAssistant conversation is resumed without chat history, its documents get the same
document access as during the live answer, so **Preview**, **Download** and **Add to email** work
there too.

- Documents are still fetched with the signed-in user's own iFinder permissions.
- Shared links do not include the Documents panel: its documents were found with the owner's
  iFinder permissions, and a viewer may not be allowed to see them.
