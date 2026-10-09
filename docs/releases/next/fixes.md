# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.

## Markdown Chat Export Converts HTML Replies Properly

Exporting a chat as Markdown left replies that arrive as HTML (for example from an app with an HTML
output format) half-converted: links, bullet and numbered lists and headings stayed as raw HTML
tags in the `.md` file, because only bold, italic, inline code and paragraph breaks were
converted. They now come out as regular Markdown links, lists and headings. Replies that are
already Markdown or plain text are exported unchanged.

- No admin action is required — the fix takes effect automatically on upgrade.
