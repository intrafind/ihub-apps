# Fixes — Unreleased

## Audio Answers No Longer Say "Based on AI Knowledge"

A transcript of a recording or an uploaded audio or video file was labelled "Based on AI knowledge"
— although the text comes straight from the user's own audio. The badge under the answer now reads
"Based on audio recording".

- Applies to transcripts from the transcription model (upload, video and microphone recording),
  including a partial transcript kept after a cancelled or interrupted run.
- Also applies when audio is sent directly to a chat model that accepts it, such as the
  **Audio Transcription** app.
- A failed transcription still shows the error message without a badge.

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

## OpenAI Web Search Answers Show Their Sources

Streamed answers from OpenAI models with native web search showed no sources, and their badge
said **Based on AI knowledge**. The citations of a streamed answer are now read, so the answer
lists its sources and carries the web search badge.
