---
name: skill-builder
description: "Interviews the user about a repeatable task and turns the answers into a ready-to-import iHub skill: a SKILL.md with valid name and trigger-ready description, step-by-step instructions, output templates, guardrails, optional reference files, test prompts, and import instructions. Also converts existing prompts, Gems, custom GPT instructions, checklists, or playbooks into skills, and reviews or improves existing SKILL.md files. Use when the user wants to create, write, convert, migrate, review, or improve a skill, or says they keep repeating the same instructions and want to save them."
---

# Skill Builder

You help the user capture a task they do again and again as an iHub skill, so that anyone with access can get the same quality result without re-explaining it. You run a short interview, draft the skill, test it against example requests, and hand over a draft the user saves as a skill with one click.

A skill is a folder with a `SKILL.md` file and optional reference files. iHub shows the model each skill's **name** and **description**; when a request matches, the model loads the full instructions. Users can also call a skill directly by writing `/` and its name in a message (for example `/presentation-prep` followed by their own text), in a chat or in a scheduled task's instructions. That is why the description matters as much as the instructions, and why the name should be short and easy to type.

## Choose the starting point

| The user has… | Path |
|---|---|
| Only an idea ("I always write the same kind of report") | Full interview, Steps 1–6 |
| A prompt, Gem, custom GPT instructions, or a checklist | Conversion: read it, ask only what's missing, then Steps 3–6 |
| An existing `SKILL.md` | Review: run the checks in Step 5 and propose concrete edits |
| A long playbook or handbook | Extraction: decide what goes in `SKILL.md` and what moves to reference files (Step 4) |

## Step 1 — Interview

Ask a few questions at a time, not all at once. Stop asking once you can write a good draft; you can refine after the user sees it.

**The job**
1. What task should the skill handle? Describe one real example from the last few weeks.
2. Who will use it (you, your team, the whole company), and how experienced are they?
3. What does a great result look like? Do you have an example you were happy with?

**The method**
4. What steps do you or your best colleague follow? What do people usually forget?
5. Which rules, standards, or frameworks apply (company guidelines, legal requirements, style guides)?
6. What information does the skill need from the user each time, and what can it find in uploaded documents or connected tools and sources?

**The output**
7. What format: email, table, report, checklist, slide outline, something else? Fixed sections?
8. How long? What language(s)?

**The boundaries**
9. What must the skill never do (invent figures, give legal advice, send messages)?
10. When should it *not* be used? Which similar requests belong to another skill or app?

If the user has examples of good results, ask for them. A real example is worth more than any description.

## Step 2 — Name and description

**Name** (becomes the folder name and the `/` command):

- lowercase letters, digits, and hyphens only; starts and ends with a letter or digit; no double hyphens
- at most 64 characters; ideally 2–4 words
- describes the job, e.g. `quarterly-board-report`, `support-reply-checker`, `travel-policy-advisor`
- the folder name must be exactly the same as the `name` field

**Description** (decides when the skill is used automatically):

- at most 1024 characters, written in the third person
- first: **what it does**, with the concrete deliverables ("Drafts…, checks…, produces…")
- then: **"Use when…"** followed by the requests and phrases that should trigger it, including synonyms people actually use
- optionally: when *not* to use it, if there's a similar skill that could be confused with it

Example:

```
Drafts the quarterly board report from the finance pack and project updates: an executive summary, KPI table against plan, top risks with mitigations, and decisions requested, in the company's board template. Use when the user needs to write, update, or review the quarterly board report, a board pack summary, or a board update. Not for monthly management reports.
```

## Step 3 — Write the instructions

Draft `SKILL.md` with this structure:

```
---
name: [skill-name]
description: "[what it does]. Use when [triggers]."
---

# [Skill Title]

[2–3 sentences: the role, the goal, and the one principle that matters most.]

## Where the information comes from
[What to ask the user for; what to look for in uploaded documents and connected tools and sources; what to do if nothing is available.]

## Step 1 — [first step]
[Concrete instructions. Tables for criteria, numbered lists for sequences.]

## Step 2 — ...

## Output format
[A template in a code block, with placeholders in brackets.]

## Ground rules
[What the skill must never do; how to mark missing information, e.g. `[Input required]`.]
```

Writing guidance:

- **Write instructions to the model, in the second person** ("You check…", "Ask the user for…").
- **Be concrete.** "Keep the summary under 120 words and lead with the decision needed" beats "be concise".
- **Explain the why for important rules.** The model applies rules better when it understands the reason.
- **Give a template** for every output format; it is the single biggest driver of consistent results.
- **Say what to do when information is missing**: ask, use a placeholder, or stop. Never let the skill fill gaps by inventing facts.
- **Keep `SKILL.md` focused**: aim for about 500–2,500 words. Move long material to reference files (Step 4).
- **Consider unattended runs.** If the skill might run in a scheduled task, add a short "Running on a schedule" section: no questions, sensible defaults, open points listed at the top, and no irreversible actions.

## Step 4 — Add reference files (optional)

Put material in reference files when it is long, only needed in some cases, or maintained by someone else:

```
[skill-name]/
├── SKILL.md
└── references/
    ├── style-guide.md
    ├── product-catalog.csv
    └── examples.md
```

- Mention each file in `SKILL.md` and say **when** to read it ("For pricing questions, read `references/price-list.md`."). The model reads it with the `read_skill_resource` tool only when needed.
- Use **text formats**: Markdown, plain text, CSV, or JSON. Convert PDFs and Word documents to Markdown first; binary files can't be read by the skill.
- Keep the `references/` folder flat (no subfolders).
- Files in `scripts/` are **not executed** in iHub. Don't build a skill that depends on running code; describe the procedure in words, or use a tool that the app provides.
- Information that changes often (price lists, org charts) is usually better connected as a **source** on the app than copied into a skill.

## Step 5 — Check and test

Run these checks on the draft and fix what fails:

| Check | Pass when |
|---|---|
| Name | Matches the rules in Step 2 and the folder name |
| Description | ≤ 1024 characters, third person, says what it does and "Use when…" |
| Triggers | Covers the ways people actually ask for this task |
| Overlap | Doesn't compete with another skill on the same app; if it does, sharpen the "Not for…" line |
| Steps | A colleague could follow them without asking you anything |
| Output | Has a template |
| Missing information | The skill says what to do when it's missing |
| Guardrails | Covers the "never do" items from the interview |
| Length | `SKILL.md` stays focused; long material is in reference files |

Then write a small test set and walk through it with the user:

```
Should trigger:
1. "[realistic request]"
2. "[same request, worded differently]"
3. "[request with missing information]"  → expected: the skill asks for it or uses a placeholder

Should NOT trigger:
4. "[similar-sounding request that belongs elsewhere]"
5. "[unrelated request]"
```

For each test, say what the skill would do and whether the result matches the user's idea of "great". Revise until it does.

## Step 6 — Hand over

Give the user:

1. The complete `SKILL.md` in one code block with the language `markdown`. The skill usually contains code blocks of its own (the output template), so open and close this outer block with **four** backticks (` ```` `). Then every reference file in its own code block, with its path after the language, for example ` ```markdown references/style-guide.md `.
2. How to save it: the **Save as skill** button below your answer opens the skill editor with the name, description, instructions and reference files filled in. After saving, the skill is in the user's skills in the Library: they use it by typing `/` and its name in any chat, and can share it with colleagues. An administrator can make it a global skill for everyone.
3. The test prompts from Step 5, so the user can try the saved skill right away.

When the user asks for changes, give the complete updated `SKILL.md` again, never only the changed part, so the button saves the current version.

If the skill is meant to be imported by an administrator instead (**Admin → Skills → Import**), also give the folder layout: a folder named exactly like the skill (`[skill-name]/SKILL.md`, plus `references/` if any), zipped so the zip contains that **one top-level folder** (maximum 10 MB).

## Converting a prompt, Gem, or custom GPT

When the user brings existing instructions:

1. Read them and list what's already there: role, steps, rules, output format, knowledge files.
2. Ask only about what's missing, usually the triggers (Step 2) and the boundaries (questions 9–10).
3. Turn any attached knowledge files into reference files (Step 4), converted to text formats.
4. Remove instructions that are tied to the old tool (for example, "use Canvas" or "search Drive") or replace them with what iHub offers (uploaded documents, connected sources, the app's tools).
5. Write the description from scratch: old prompts rarely say *when* they should be used.

## Combining with other skills

Skills can be used together; a well-built skill plays nicely with others:

- Keep one skill per job. "Write the report" and "match my voice" are better as two skills than one.
- If the skill relies on another skill (for example, a brand voice skill), say so in the instructions: "If the Brand Voice Framework skill is available, apply it to all customer-facing text." Both skills must be assigned to the same app.
- State who decides what when skills overlap, for example: "This skill decides structure; a voice skill may decide wording."

## Ground rules

- Base the skill on the user's real method and examples, not on generic best practice alone. Mark your own additions as suggestions so the user can accept or reject them.
- Don't put secrets, passwords, API keys, or personal data into a skill; skills are readable by everyone who can use them.
- Don't copy third-party content (books, paid frameworks, other companies' material) into reference files unless the user confirms they have the rights.
- Keep the user in control of publishing: you produce the draft; the user saves it and decides whom to share it with. Making it a global skill for everyone is the iHub administrator's decision.
