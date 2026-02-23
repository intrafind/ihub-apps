---
name: interview-to-blog
description: >
  Produce deep, long-form blog posts (1,800–2,500+ words) by interviewing the user first, 
  researching the topic, architecting the structure, then writing. Use this skill whenever 
  the user wants to create a blog post, write an article, draft a long-form piece, or asks 
  for help turning their expertise into written content. Also trigger when the user says 
  things like "help me write about," "I want to blog about," "turn this into a post," 
  "ghostwrite," "interview me," or "write-up." Do NOT use for short social media posts, 
  email drafts, or documentation — only for substantive blog-style content.
license: Apache-2.0
metadata:
  author: IntraFind
  version: '1.0'
---

# Interview-to-Blog Post Skill

A four-phase workflow that produces deep, long-form blog posts by interviewing the user first, researching the topic, then synthesizing everything into content that reads like it was written by a domain expert — because it was shaped by one.

**Core insight: the depth of AI output is directly proportional to the depth of human input.** Most AI blog posts feel shallow because the writer skips the hardest part — extracting what they actually know and think. The interview phase solves this.

## Why Interview-First Beats Outline-First

The dominant approach — "generate outline → expand sections → polish" — produces generic content because the AI draws entirely from its training data. Interview-first inverts this: extract unique knowledge, specific examples, and genuine opinions _before_ structuring anything.

## Workflow Overview

The skill runs four sequential phases. Each phase builds on the previous one.

| Phase           | Purpose                                            | Duration  | Reference                                                                |
| --------------- | -------------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| 1. Interview    | Extract the user's unique knowledge and opinions   | 10–15 min | [references/phase-1-interview.md](references/phase-1-interview.md)       |
| 2. Research     | Gather external evidence and ask deeper follow-ups | 5–10 min  | [references/phase-2-research.md](references/phase-2-research.md)         |
| 3. Architecture | Structure the post for depth, not length           | 3–5 min   | [references/phase-3-architecture.md](references/phase-3-architecture.md) |
| 4. Writing      | Produce the final blog post                        | Automated | [references/phase-4-writing.md](references/phase-4-writing.md)           |

## How to Execute

### Phase 1: Interview

Read [references/phase-1-interview.md](references/phase-1-interview.md) for the full interview protocol.

Key rules:

- Ask exactly ONE question per message. Never bundle multiple questions.
- Use the Open-Focused-Closed progression (2–3 open → 4–5 focused → 2–3 closed)
- Push for specific examples, names, numbers, timelines, and counterarguments
- Ask 8–12 questions total, then say **"INTERVIEW COMPLETE"** and summarize key themes
- Do NOT write any blog content during this phase

Start with: **"What topic do you want to write about, and who is the intended reader?"**

### Phase 2: Research

Read [references/phase-2-research.md](references/phase-2-research.md) for the full research protocol.

After the interview summary:

1. Identify 5–8 research gaps where external evidence would strengthen the post
2. Conduct web research (if search tools are available) for statistics, expert quotes, and real examples
3. Prioritize named sources, quantitative data, recent information (2024–2026), and surprising findings
4. Ask 3–5 deeper follow-up questions at the intersection of the user's experience and the research

### Phase 3: Architecture

Read [references/phase-3-architecture.md](references/phase-3-architecture.md) for the full architecture protocol.

After the user answers follow-up questions:

1. Propose 3 headline options (specific, intriguing — no clickbait)
2. Write an opening hook (surprising fact, concrete anecdote, or bold claim)
3. Create a section-by-section blueprint (4–6 sections) with core arguments, evidence mapping, and word counts
4. Define the narrative arc and closing strategy
5. **Wait for user approval before writing**

### Phase 4: Writing

Read [references/phase-4-writing.md](references/phase-4-writing.md) for all voice, style, depth, and anti-slop rules.

After the user approves the architecture:

1. Write the complete post (1,800–2,500 words) following all style and anti-slop rules
2. Weave interview insights with research evidence naturally
3. Include at least 3 named examples, 2 counterarguments, and 1 actionable framework
4. Produce the post as a markdown file
5. Add POST-WRITE NOTES flagging claims to fact-check, weak sections, and suggested visuals

## Quick Mode

If the user wants a faster process, collapse into a single-pass approach:

1. Interview (8–10 questions, one at a time)
2. Research + 3 follow-up questions
3. Write directly (skip separate architecture approval)

Trigger quick mode when the user says things like "quick post," "keep it simple," or "don't need the full process."

## Quality Benchmarks

A successful output from this skill should have:

- **Information density**: Every sentence contains information or insight, no transitional filler
- **Specificity**: Named companies, people, studies; quantitative data; real examples
- **Originality**: Content shaped by the user's unique experience, not just training data
- **Structure**: Narrative arc where each section's conclusion raises the question the next answers
- **Voice**: Approachable intelligence — like explaining something fascinating to a smart friend
