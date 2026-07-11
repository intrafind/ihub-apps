# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.

## Audio Attachments Reach vLLM Models That Support Audio

Audio attached to a chat with a vLLM model that has **Supports Audio** enabled was silently
dropped: the model only saw the text of the message. vLLM models now receive the audio the same
way OpenAI models do. Models without the flag are unaffected.
