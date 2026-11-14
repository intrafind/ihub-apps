# Agentic Chat

**Status:** Research and concept (2026-11-07); team decisions of 2026-11-08 recorded in §8 of the main document

## Why

Claude.ai and ChatGPT work through a request until it is done: they decide what to look up, search, read, compute, check and search again, and only then answer. iHub chat, with the same models, does noticeably less. This folder records what those products and the leading open-source harnesses do, where iHub falls short, and how iHub chat gets to the same level.

## Main finding

iHub already has the loop (`AgentLoop`). The gap is around it:

1. iHub throws away the model's reasoning between tool calls for Claude and OpenAI (and self-hosted reasoning models), which is how these models plan and re-plan.
2. Nobody tells the model how much work a request deserves, to finish the job, or what a final answer is.
3. Chat lacks the tools and loop settings the others have: code execution, a plan tool, delegation to sub-agents, a research mode, parallel tool calls, budgets sized to the job, and a check that a text-only reply really is the end.
4. There is no evaluation that compares iHub with Claude.ai and ChatGPT.

## Decisions (2026-11-08)

- The chat modes are a switch from the start; existing apps keep today's behaviour (Classic) preselected until the eval shows Standard is better.
- Deep Research is a mode of its own.
- Provider server tools beyond today's native web search come in a later phase.
- Code execution waits for a backend (#2663).
- Quotas for Deep and Deep Research: run counts per mode on top of the existing token limits (defaults: Deep 10 per day / 40 per month, Deep Research 3 per day / 15 per month), concurrency limits and per-run budgets; see §5.9 of the main document.
- We build the evaluation harness ourselves, first, in Phase 0.

## Documents

- **[Agentic Chat — Closing the Gap to Claude and ChatGPT](<2026-11-07 Agentic Chat — Closing the Gap to Claude and ChatGPT.md>)**: summary, comparison, iHub gap analysis with file references, target design (seven layers, chat modes, quotas), roadmap, risks, the decisions of 2026-11-08, a draft operating-manual prompt. **Read this first.**
- Research notes (code-level and documentation findings, with sources and fact/inference markers):
  - [Claude: Claude.ai, Research, Claude Code, Claude API](<research/2026-11-07 Claude.md>)
  - [ChatGPT, OpenAI APIs, Codex, Gemini](<research/2026-11-07 ChatGPT and Gemini.md>)
  - [LibreChat and Open WebUI](<research/2026-11-07 LibreChat and Open WebUI.md>)
  - [mini-swe-agent, Hermes Agent, Deep Agents](<research/2026-11-07 mini-swe-agent, Hermes Agent, Deep Agents.md>)
  - [Quotas for Deep and Deep Research: market limits and cost per run](<research/2026-11-08 Quotas for Deep and Deep Research.md>)

## Related

- [Agent Harness Comparison (2026-08-26)](<../2026-08-26 Agent Harness Comparison — DeepSeek Harness, Hermes, Deep Agents vs iHub.md>): audit, approvals, scheduling, sandboxes.
- [One Agentic Loop (2026-08-26)](<../2026-08-26 One Agentic Loop — Unified Runtime for Chats, Workflows and Agents.md>): the shared `AgentLoop` / `LLMClient` runtime this design builds on.
- Issues: #1040 (Deep Research), #2603 (reasoning toggle), #2663 (sandboxed code execution), #3015 (Gemini thinking), #3191 (steer a running answer), #3196 (sub-agents), #3365 (memory).
