# Features — Unreleased

## Scheduled Tasks: Larger Notes That Keep Themselves Current

Tasks that remember between runs now have twice the room for their notes, and the notes keep
themselves within it instead of filling up.

- The default limit is 16000 characters (was 8000). Installations still on the old default are
  raised automatically; a limit an admin set stays as it is.
- Every entry in the notes carries the date it was last confirmed. When the notes need room, the
  entries not seen for the longest time go first, then older ones are condensed. The latest
  state, open follow-ups and the owner's preferences are kept.
- The run's row on the task page shows **Memory full** or **Memory not updated** when the notes
  could not be updated and the previous notes were kept.

## Deleting a User Removes What They Owned

Deleting a user now removes everything that was filed under them, not just the account. Before,
their API keys, connections and stored credentials stayed behind with nobody able to reach them,
and for people who sign in through an identity provider a new sign-in creates a new account, so the
old data was never cleaned up.

- **Always removed:** personal API keys, OAuth connections (consents and refresh tokens), the
  credentials the user stored for other systems (Office 365, Jira, Google Drive, Nextcloud and
  MCP servers), and their scheduled tasks with run history and notes.
- **Also removed for now:** their chats (with runs, shares and workflow state), prompts and skills
  (with versions and shares), and short links. Anything others had through a shared prompt, skill
  or chat link goes with it. A way to keep this content and hand it to another user instead is
  planned.
- **Kept:** the audit log and usage statistics.
- The clean-up runs in the background, so deleting a user stays fast however much they owned. The
  account itself is gone, and access with it, before the request answers. When the clean-up
  finishes, the audit log gets a `cleanup` entry for the user; it names any part that could not be
  removed.

## Apps and Workflow Nodes Can Require a Tool Call

Some models answer from memory when an app wanted them to look something up. An app can now
require that the model's first step of every message calls one of the app's tools.

- Set **Tools → Tool use → Use a tool first** in the app editor (`toolChoice: "required"` in the
  app's JSON). Workflow `prompt` nodes take the same setting as `config.toolChoice`.
- Only the first model call is required. After the tool result the model answers freely, so the
  message still ends in an answer.
- Models the provider cannot force — for example Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 — are
  asked in words instead. A model that rejects the setting is detected on its first call, handled
  without an error and remembered for an hour. A model's **Tool Calling** setting
  (`supportsTools: "none" | "auto" | "required"`) says up front which models can be forced: only
  `required` models are, `auto` models are asked in words.
- Supported for OpenAI, OpenAI Responses, Mistral, vLLM, Anthropic, Google Gemini and Amazon Bedrock
  models; other local servers may ignore it. See
  [Tool Calling](../tool-calling.md#requiring-a-tool-call).

## Tool Scripts Are Checked at Startup

A tool whose script is missing, cannot be loaded or lacks the function its definition declares used
to fail the first time a model called it, in the middle of a chat. The server now checks every
enabled script-backed tool at startup and logs a warning naming the tool and the reason, for
example a package that is not installed. Nothing stops the server: fix the script or disable the
tool. A tool entry that points at a script file that does not exist is also reported whenever the
tools are loaded.
