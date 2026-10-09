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

## Apps and Workflow Nodes Can Require a Tool Call

Some models answer from memory when an app wanted them to look something up. An app can now
require that the model's first step of every message calls one of the app's tools.

- Set **Tools → Tool use → Use a tool first** in the app editor (`toolChoice: "required"` in the
  app's JSON). Workflow `prompt` nodes take the same setting as `config.toolChoice`.
- Only the first model call is required. After the tool result the model answers freely, so the
  message still ends in an answer.
- Models the provider cannot force — for example Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 — are
  asked in words instead. A model that rejects the setting is detected on its first call, handled
  without an error and remembered for an hour. Set `supportsForcedToolUse: false` in a model's
  config to skip the attempt.
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
