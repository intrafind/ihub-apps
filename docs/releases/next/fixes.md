# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.
