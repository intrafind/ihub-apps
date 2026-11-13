# Product brief: say where an answer came from (origin-aware activity, sources and skills)

Status: draft for the product owner (PM role of the review panel). Date: 2026-11-13.
Repo state read: `main` at 20f5a5c (the footer chip is already "AI-generated | kinds", one commit newer than the fact base's mock-up).
This document lives in `concepts/2026-11-13 Activity origin/` with the other documents of this concept. It was written as a read-only review: nothing in the source was changed.
Inputs: `00-fact-base.md`, screenshot `images/1.png`, `concepts/2026-11-12 Answer Footer Basis Chip.md`, `docs/answer-sources.md`, issues #3038, #3521, #3619 as summarised in the fact base, and the code cited below.

Evidence rule used throughout: **O** = observed (screenshot or code I read; not run), **A** = assumed (hypothesis, not validated), **V** = must be verified before build. No user research exists yet. Nothing here is real user data.

---

## 0. Recommendation in one screen

Challenge to the request: "split the activity by origin type and label sources by origin" is half right. Origin must be stated everywhere (streaming line, summary, rows, source cards, one vocabulary). Splitting the **expanded timeline** into per-origin groups is the wrong half: it destroys the one thing a timeline is for (the order in which the assistant tried things, e.g. "looked in your project, found nothing, went to the web") and it is the most expensive and least stable option while streaming.

Recommended: **Option C, "origin-aware flat timeline"**.

1. The server names the origin of every search/read/connected-system call with the **same kinds the footer chip already uses** (`project | web | ifinder | iassistant | documents | integration`). One vocabulary, one server function.
2. The collapsed line stops being a run-on string. It becomes **one segment per origin** (icon + noun + that origin's counts + that origin's provider last): `[globe] Web · 1 search · 5 results · 5 pages read · Brave Search   [folder] Project · 1 search · no matches`.
3. The expanded list stays **chronological and flat**; every row says its origin in words (icon is decoration), says "no matches" when a search found nothing, and keeps the provider at the end of its own row.
4. While streaming, the headline names the origin: "Searching the web for ...", "Searching project documents for ...". Today it does not (O4).
5. Sources panel cards get an origin label (MVP); an origin filter follows (Next).
6. **A skill gets one home: the header chip**, with who started it in words ("started by you / loaded by the model / set by the app"). The skill row and the "N skills" count leave the timeline.
7. Raw tool arguments (`extractContent`, `maxLength`, `offset`, `limit`) go behind a **"Technical details" toggle for everyone**, default off. Not admin-gated.

Not building: per-origin groups in the expanded timeline, "triggered by" on search rows, colour per origin, merging "Show thinking analysis" into the timeline, any client-side guessing of origin, a compat mapping for old chats (recommendation: clean break).

---

## 1. Problem statement

### Who
- Knowledge workers in German enterprises using iHub chat (main chat, Outlook task pane at 320 px, browser extension, phones). They ask "did it use our documents or the public web, and may I trust or quote this?" (A1, A3).
- Reviewers who open a shared chat read-only (same question, less context).
- Admins and app builders who configure apps, tools, projects and integrations and must diagnose "why was this answer thin?" (A6).
- Screen-reader users (the timeline is `aria-live="off"`; `RunAnnouncer` speaks for it).

### What is wrong (observed)
- **O1** The collapsed line is one run-on string: `Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search`. Counts of two different origins are added together ("2 searches") and the provider is detached from the web part it belongs to. Built in `activityHeadline.js:240-267` (`searchedParts`), `:300-314` (`finishedHeadline`; integrations are appended last at `:311-312`).
- **O2** The project search row shows no result count and no hits, so a search that found nothing looks like nothing happened (`ToolActivity.jsx:279-283`: the count renders only when `sources.length > 0`). Whether the project had no match is the most useful fact in this run: it explains why the answer rests on the web.
- **O3** Three web page reads come after the project search row, same level, same glyph family, no origin word. They read as children of the project search. The list is chronological by design (`shared/run/toolActivity.js:322-345`).
- **O4** While a call runs and has a query, the headline says only `Searching for “q”` for every origin. The origin words ("Searching the web…" / "Searching documents…") appear only when there is no query yet (`activityHeadline.js:185-191`). The moment where "state it out" matters most (the user can still stop it) is the one that does not state it.
- **O5** The server collapses its finer knowledge into `web | documents` before sending (`server/utils/toolDisplay.js:58-65`, schema `server/services/loop/contracts/sseV2.js:173`), although `classifyToolKnowledgeSource` already knows `websearch | ifinder | project | sources | integration` (`server/services/loop/seams/knowledgeSourceSeam.js:52-66`). The client cannot tell project from iFinder from configured sources.
- **O6** Same word, different meaning: the timeline says "Searched documents" for a project (and iFinder) search, while the footer kind `documents` means only admin-configured sources (`server/services/chat/answerBasis.js:25-39`; chip nouns in `concepts/2026-11-12 ...`). Three vocabularies exist for one idea: activity `scope`, source `provider`/`kind`, footer `answerBasis.kind`.
- **O7** A skill is drawn twice: a purple header pill (`ChatMessage.jsx:284-290`, `:971-985`) and a `SkillRow` "Used skill X, started by you" (`ToolActivity.jsx:228-251`), plus "N skills" in the headline (`activityHeadline.js:303-306`).
- **O8** "Who started the skill" has three real answers on the server but two on the wire. `resolveSkillsForTurn` knows origins `requested | message | app | chat` (`server/services/skillAccess.js:571-636`). `announcedSkills` labels every one that is not carry-over `activatedBy: 'user'` (`server/routes/chat/sessionRoutes.js:134-144`), so an app that auto-activates a skill (`skillSettings.autoActivate`) shows "started by you". The wire, reducer and store accept only `user | model`. Skills carried over from earlier turns (`origin: chat`) are announced nowhere (filtered at `sessionRoutes.js:136`); I did not find another place that shows them (V3).
- **O9** The stored activity row is a whitelist (`server/services/chat/runActivity.js:354-380`, `boundToolItem`) that has no `integration`. Read literally, a reopened chat cannot show the "Brave Search" chip or the provider tail of the headline (V1: reproduce by reopening a chat after a web search). Shared chats keep only `id, kind, toolId, name, activatedBy, status, scope, query` for non-public calls (`runActivity.js:547-575`).
- **O10** Footer and timeline can disagree. `classifyKnowledgeSource('read_url')` returns null (`knowledgeSourceSeam.js:27-41`; `postTool` exits on null at `:117`), so an answer whose only retrieval was `read_url` (user pasted a URL) probably gets basis "Model knowledge" while the timeline shows a web read (V2: reproduce).
- **O11** Raw arguments are shown to everyone (`ToolActivity.jsx:484-510`, `ItemDetails`; `shownArgs` hides only query/url/documentId, `toolActivity.js:159-174`). Shares already drop `details` for private calls (`runActivity.js:547-575`), and owner/admin can read the full run through `GET /api/runs/:runId/events` (`docs/run-ledger.md`).
- **O12** Source cards show favicon/document icon, `site`, date and an integration-scope chip, never the origin noun. For project documents `site` is the project name (`server/services/sources/producers/project.js:51`) and the icon is a generic document (`AnswerSources.jsx:1244`). `ScopeFilter` filters by integration scope only (`AnswerSources.jsx:791`).
- **O13** "Read" appears three ways (hit marker, read rows, "5 pages read"). The count is distinct sources with `read.ok`, so "5 pages read" with 3 read rows is arithmetically consistent but reads as a contradiction (`activityHeadline.js:173-178`).
- **O14** Consumers of the activity `scope`: headline (`activityHeadline.js:173-176, 240-257, 338-344`), voice-mode status (`client/src/features/voice/utils/voiceText.js:47`), row construction (`toolActivity.js:348-351`).
- **O15** No client analytics exists (`grep` of `client/src`: none). Server metrics exist (`ihub.feedback`, `ihub.app.usage`, `ihub.stream.outcome`, ... in `server/telemetry/metrics.js`).

### Why now
- The footer chip (#3619, #3658, #3665) just made the origin vocabulary visible at the end of every answer. The activity line above it still speaks a different language, so the two now visibly disagree (O6, O10).
- #3038 (tools declare what they are) is open; carrying the finer origin the server already has is its natural first step.
- The product owner called the line "completely confusing" (A2, n=1, but the observed code supports it).

### Assumptions to validate (A)
- A1 German enterprise users read internal-vs-public as a trust and compliance signal.
- A2 The run-on line, not the row detail, is the main confusion.
- A3 Users also care about egress: "did my question leave the company?" The row already shows the exact query; naming the origin and provider next to it makes that explicit.
- A4 For searches and reads, "who triggered it" is always the model (inside what the user or app enabled: web-search toggle, attached project). Only skills have a real triggering actor (user `/name`, model, app).
- A5 Mixed-origin answers are common enough to matter. Unknown; metric M3 sizes it.
- A6 Admins accept a "Technical details" toggle because the run ledger exists for deep diagnosis.

---

## 2. Jobs to be done

1. **Trust check.** When I read an answer at work, I want to see at a glance whether it used our internal documents, the public web, or both, so I can decide how far to trust it and whether I may quote it outside.
2. **Live control.** While the assistant works, I want to see where it is looking right now, so I can stop it before it sends my topic to the public web or searches the wrong place.
3. **Why thin or wrong.** When an answer is weak, I want to see what was tried and what came back empty ("project: no matches, so it used the web"), so I can attach the right project, rephrase or choose another source.
4. **Verify a claim.** When I check a source, I want to know which system it lives in, so I open it in the right place and judge its authority.
5. **Diagnose (admin).** When a user says "this is wrong", I want tool, arguments, provider and truncation one click away without cluttering everyone's view, so I can fix configuration (wrong profile, limit too small, truncated read).

---

## 3. Goals, non-goals, binding decisions

### Goals
- G1 At every moment (streaming and finished) the user can tell which origin each action touched, in words.
- G2 One origin vocabulary across the activity line, source cards and footer chip, decided by the server.
- G3 A search with no result is stated, not silent.
- G4 A skill appears once, with who started it.
- G5 Technical arguments stop being everyone's default reading.
- G6 No regression for 320 px, German length, dark mode, screen readers, shared chats.

### Non-goals
- No new colour per origin. No per-row "triggered by". No re-ordering of the timeline. No change to what the model does or which tools exist. No new analytics pipeline in the browser. No redesign of the "Show thinking analysis" disclosure (its own follow-up, left open in #3521). No change to the answer footer except fixing O10.

### Binding prior decisions (do not reopen)
- #3521: activity stays at the top of the answer; results tile at the end; "results", not "sources".
- #3619/#3658/#3665: one outlined chip; kinds named by the server; colour does not distinguish kinds (icon plus noun do); "Model knowledge", never "no sources"; clickable = outlined, status = tinted; targets at least 24 px; nothing only in `title`.
- CLAUDE.md: the server decides, the client renders (new distinction = new server-sent field, never inferred from a tool id); additive API changes; ask before compat shims; EN and DE strings; a11y; release note under `docs/releases/next/`.

---

## 4. The shared origin vocabulary (proposal)

Reuse `ANSWER_BASIS_KINDS` (`shared/runEvents.js:47`). A tool call's origin is the subset a call can have: `project | web | ifinder | iassistant | documents | integration`. `email | file | audio | model | workflow` stay footer-only (they are inputs or fallbacks, not tool calls).

| Tool class | Server classifier today (`classifyToolKnowledgeSource`) | Activity `scope` today | Footer kind today | Proposed origin |
|---|---|---|---|---|
| Brave / Qwant / Staan / web-search integration / provider-run search | `websearch` | web | web | `web` (provider label = existing `integration`, e.g. "Brave Search") |
| `read_url` | null (O10) | web | none | `web` (and footer fixed to match) |
| `knowledge_*` | `project` | documents | project | `project` |
| `ifinder*` | `ifinder` | documents | ifinder | `ifinder` |
| `source_*` (admin-configured) | `sources` | documents | documents | `documents` |
| Integration / MCP / A2A (Jira, Munich AD, ...) | `integration` | none (plain call) | integration + label | `integration` + label |
| Loop-internal tools, file/document creators | null | none | none | none (stay plain calls) |
| Provider-run web search row (`native-web-search`, synthesized from grounding) | n/a | web | web | `web` (set where the row is built; edge case needing its own test) |

Mapping function: one server function, `activityOriginOf(toolDef)` next to `toolDisplayOf`, built on `classifyToolKnowledgeSource` plus the existing `KIND_OF_SOURCE` table (`answerBasis.js:25`). The footer and the timeline then cannot drift because they read the same classifier. Declared-on-the-tool origins (#3038) replace the classifier later without changing the wire.

Proposed contract (tech lead to confirm):
- `tool/started`, the `args` progress frames (the row exists while arguments stream) and the ledger `tool/call`: optional `activityOrigin: 'project'|'web'|'ifinder'|'iassistant'|'documents'|'integration'`. The ledger needs it too: runs that died are rebuilt from the ledger (`runActivity.js` header), and a re-sync replays it. Same shape of schema entries as `activityScope` (`sseV2.js:173`, `runLogEvents.js:292`).
- Provider keeps riding on the existing `integration` string.
- Row item (`buildToolActivity`): `origin`. Stored and shared whitelists get `origin` (kind only for private calls in a share; label only for the public web items that are already shared whole).
- Source (`shared/sources/source.js`): optional `origin: { kind, label? }`, the same shape as an `answerBasis` entry, set by the producers (`web`, `ifinder`, `project`, `declared`, `envelope`, grounding).
- Skill frame: `activatedBy: 'user' | 'model' | 'app'`.
- `activityScope` stays on the wire this release, with no new consumer (see open decision Q4).

---

## 5. Options considered

| | Shape | Core idea |
|---|---|---|
| **A** | Group per origin (the request) | Expanded timeline split into "Search in web", "Search in projects", ... groups, each with icon, action, hits, provider last |
| **B** | Chip on every row | Keep the chronological list; add an origin chip/icon to every row and every source card |
| **C** | Hybrid (recommended) | Chronological flat list with origin words and icon in each row, per-origin segments in the collapsed summary, origin on source cards, one skill home, details behind a toggle |
| **D** | Wording only | Client-only: split the headline by the existing `web | documents` scope, no server field |

### Decision matrix
Ratings are my judgement, not data: ++ strong, + good, 0 neutral, - weak, -- poor.

| Criterion | A groups | B chip per row | C hybrid | D wording only |
|---|---|---|---|---|
| States "where" at a glance (summary) | ++ | - (summary stays run-on) | ++ | 0 |
| Distinguishes project / iFinder / web / Jira | ++ | ++ | ++ | -- (only web vs documents) |
| Keeps the run's story (order, fallback) | -- | ++ | ++ | ++ |
| Stable while streaming (no reflow; origin stated live) | - (groups appear and reorder; interleaved web-project-web must split or lie) | ++ | ++ (segments only append) | + |
| 320 px and German length | - (nested groups, indentation) | - (a chip per row wraps) | + (segments wrap, one origin per line) | + |
| One vocabulary with footer and sources | 0 | ++ | ++ | -- |
| Fixes the skill duplication and "who" | 0 | 0 | ++ | 0 |
| Effort and regression risk (inverse) | -- (L; rewrites a 1,732-line component test, announcer, voice, stored shape) | + (M) | + (M) | ++ (S) |
| Stored and shared chat safety | 0 | + | + | ++ |
| Consistent with #3521/#3619/#3038 | - | + | ++ | -- |

Why not A, concretely:
- Interleaving: web search, project search, then a second web search. One web group lies about order; two web groups look like a bug.
- Plain calls and skills need an "Other" group; an agentic run with Jira, Munich AD and iFinder creates one group per system, so the expanded view gets longer, not clearer.
- Streaming: the group order ("first web, then projects") is unknowable until the model has decided; a header that appears later and shifts rows is exactly the layout churn #3521 was built to avoid.
- It still does not touch the Sources panel, the skill pill or the run-on summary.
- Its one good idea, origin-scoped counts, is fully captured by C's summary segments.

Why not B alone: it leaves the collapsed line, the part the product owner called confusing, untouched, and repeats an identical chip on every row.
Why not D: it cannot separate a project search from an iFinder or configured-source search and keeps three vocabularies. It is the right fallback only if the server work is cut (then ship it explicitly as a stopgap, not as the answer).

### Recommendation
**C.** It is B's row treatment plus A's good idea confined to the summary, plus two fixes (skill home, details) the other options ignore. Revisit A only as an optional "Group by origin" view if research (section 13) shows people scan by origin rather than by sequence.

### What we would NOT build
1. Per-origin groups in the expanded timeline (A).
2. A "triggered by" label on search and read rows (A4; every one would read "the model", noise).
3. Colour per origin (#3619).
4. Client-side inference of origin from tool id, `provider` or the old `scope` (CLAUDE.md; `documents` is ambiguous).
5. A mapping layer for chats stored before the change (pending Q1; recommended clean break).
6. Project or search-profile names on timeline rows in the MVP (privacy in shares; Next).
7. An admin-only UI variant (different UIs for admin and user make screenshots undebuggable).
8. Click analytics in the browser.
9. Merging reasoning ("Show thinking analysis") into the activity list.

---

## 6. Recommended design in words

All wording below is working copy for the technical writer. German uses the existing "Gesucht nach" pattern and the informal "du" already used in `de.json` (`skillByUser`: "von dir gestartet").

### 6.1 Streaming headline (replaces O4)

| Origin | EN | DE |
|---|---|---|
| web | Searching the web for “q” | Im Web gesucht wird nach „q“ (final copy: tech writer) |
| project | Searching project documents for “q” | In Projektdokumenten wird gesucht nach „q“ |
| ifinder | Searching iFinder for “q” | In iFinder wird gesucht nach „q“ |
| documents | Searching documents for “q” | In Dokumenten wird gesucht nach „q“ |
| integration | existing `{{name}} · {{integration}}…` | unchanged |
| read, web | Reading {{host}} | unchanged |
| origin unknown | existing generic text, no guess | unchanged |

Built in `activeLabel`/`searchLabel` (`activityHeadline.js:185-230`). `RunAnnouncer` reads `activeLabel`, so the screen reader gets the origin for free (`deriveAnnouncements.js:102`); skill rows are already skipped there (`:172`).
Because the leading slot is a spinner while busy and the status icon wins on error/awaiting, **the origin must be in the words; the icon is decoration**.

### 6.2 Finished headline: one segment per origin

```
Today (O1)
 [globe] Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search  ^

Proposed, wide
 [globe] Web · 1 search · 5 results · 5 pages read · Brave Search     [folder] Project · 1 search · no matches   ^

Proposed, 320 px (segments wrap, one origin per line, no ellipsis)
 [globe] Web · 1 search · 5 results ·
         5 pages read · Brave Search
 [folder] Project · 1 search · no matches
```
Rules:
- Segment = origin icon (same as footer `KIND_ICON`) + noun (same strings as `chatMessage.answerBasis.kind.*`) + searches + results + pages/documents read + provider list last (honours the product owner's "provider at the end" inside its own group).
- Order = first use; segments only append, so nothing jumps while streaming.
- Counts belong to their segment only (fixes "2 searches").
- "no matches" when the origin's searches returned nothing and none failed; failures keep "Failed".
- Named at most two, then "+N" (same rule as the footer chip); the button's accessible name lists all.
- Finished state wraps instead of truncating (`ToolActivity.jsx:84` today truncates).
- Plain calls keep today's wording ("Created PDF", "1 tool call"). The headline's leading `lookedAtIcon` heuristic (`activityHeadline.js:338-344`) goes away once segments carry their own icons.
- A row without origin (old chats, unclassified tools) lands in a segment with no icon and no noun: "N searches · M results".

### 6.3 Expanded rows (chronological, flat)

```
 [globe]  Searched the web for [IntraFind iFinder6] · 5 results · Brave Search
            iFinder: Enterprise AI Search You Can Trust   intrafind.com   (eye) Read
            ... (4 more hits)
 [folder] Searched project documents for [iFinder6] · no matches
 [globe]  Read page  iFinder: Enterprise AI Search ...  intrafind.com  1,334 words read  truncated
 [globe]  Read page  ...
                                              [ Technical details: off ]
```
- Origin phrase in the verb; origin icon leads when completed; status icon leads while running, failed or awaiting.
- Reads show the web icon and host, so they stop reading as children of the project row, with no regrouping.
- Provider stays at the end of its row (today's `IntegrationChip`, `ToolActivity.jsx:467-478`, but the text carries it, not a `title`).
- Hit-level "Read" marker unchanged (O13 handled in research, not in the MVP).

### 6.4 Skill: one home
- Home = the header chip. Text: `[sparkles] Contract review  started by you | loaded by the model | set by the app`. Wraps under the name at 320 px.
- Removed: `SkillRow`, the "N skills" part of the headline. Old stored `kind: 'skill'` rows are simply not drawn.
- Why the chip and not the timeline: a skill is not an origin of information; it is how the whole answer was instructed (like model or app). It must stay visible when the timeline is collapsed, and it must not compete with origin segments. For `/name` the user's own message already shows the trigger; for model-loaded and app-set skills the chip is the only evidence.
- The reverse choice (timeline is home, name goes into the summary) is the alternative in Q3. Flip it if research shows people look to the timeline for "what happened".
- Fix O8: `announcedSkills` maps `requested|message` to `user` and `app` to `app`.

### 6.5 Technical details
One toggle at the end of the expanded list ("Technical details", `aria-pressed`, at least 24 px target), default off, remembered per browser in `localStorage` inside try/catch (page works without it). Off: no argument names or values except what the row already shows (query, url, document title). On: today's argument chips plus tool id and duration. Not announced by `RunAnnouncer`. Whether it is for everyone or admins only is Q2 (recommendation: everyone).

### 6.6 Sources panel
- MVP: the card's meta line starts with the origin: `[globe] Web · intrafind.com · 12 Nov`, `[folder] Project · Project Alpha · Uploaded`, `[doc] iFinder · [folder-chip Contracts]`, `[link] Jira`. Icon aria-hidden, noun is text. No `origin` on the source (old data) = card unchanged.
- Next: origin filter pills reusing `ScopeFilter` (`AnswerSources.jsx:791`). This is where grouping/filtering pays off, because sources are a set, not a sequence.

---

## 7. User stories and acceptance criteria

Priorities: M = Must (MVP), S = Should, C = Could. "Verify" names where the test lives.

**US-1 (M) Streaming says where.** As a knowledge worker, I want the live line to name where the assistant is searching, so that I can stop a search I do not want.
- Given a running call with `activityOrigin: web` and query "iFinder6", When the headline renders, Then the text names the web and the query (EN and DE).
- Given the same with `project`, `ifinder`, `documents`, Then the text names project documents, iFinder, documents respectively; given `integration` with label "Jira", Then the text contains "Jira".
- Given a call with no origin (older server, unclassified tool), Then the existing generic text shows and no origin word is guessed.
- Given a screen reader, When the call starts, Then the announced text contains the same origin phrase, without numbers or a trailing ellipsis.
- Verify: `tests/unit/client/tool-activity.test.jsx`, `run-announcer.test.jsx`.

**US-2 (M) Finished line summarises per origin.** As a knowledge worker, I want the collapsed line to say what happened per origin, so that I can judge the answer without opening it.
- Given the run of the screenshot (Brave search with 5 results and 5 pages read, project search with 0 results, 3 web reads), When finished and collapsed, Then there are two segments in order of first use: Web with "1 search, 5 results, 5 pages read, Brave Search" and Project with "1 search, no matches", and no provider name appears after the last segment.
- Given three or more origins, Then two are named and the rest is "+N"; the button's accessible name lists all; no text is cut off with an ellipsis.
- Given a turn with only creator calls (PDF), Then no origin segment appears and "Created PDF" is unchanged.
- Given rows without origin, Then they appear as one unlabeled "N searches · M results" segment and nothing is guessed from `scope`.
- Given 320 px width in German, Then there is no horizontal scroll and segments wrap.
- Verify: `tool-activity.test.jsx` (headline), a11y e2e `tests/e2e/accessibility.spec.js`.

**US-3 (M) Rows say where; empty is not silent.** As a user, I want each row to state its origin and result, so that a read does not look like the child of another origin's search.
- Given rows [web search, project search, web read], Then each row's text names its origin, the read row shows web icon and host, and no row is indented under another.
- Given a search with zero results and no error, Then its row shows "no matches" (DE "keine Treffer"); given an error, Then it shows "Failed", never "no matches".
- Given a running or failed row, Then the status icon leads and the origin is still in the text.
- Given a creator call, Then its row has no origin.
- Verify: `tool-activity.test.jsx`.

**US-4 (M) A skill has one home.** As a user, I want a skill shown once, so that I am not confused by two displays.
- Given a skill activated live, in a stored chat, and in a shared chat, Then it is rendered exactly once (the header chip) and not in the timeline or in the headline count.
- Given a stored answer whose `toolActivity.items` still contains a `skill` row, Then that row is not drawn.
- Given the model loads the same skill twice, Then one chip shows.
- Verify: `tool-activity.test.jsx`, `stored-run-activity.test.jsx`, a message-level test in `chat-message-sources-layout.test.jsx` or a new one.

**US-5 (M) The chip says who started the skill.** As a user, I want to know whether I, the model or the app started a skill.
- Given `/name` typed by the user or a skill picked in the composer, Then "started by you".
- Given the model calls `activate_skill`, Then "loaded by the model".
- Given an app with `skillSettings.autoActivate`, Then "set by the app" (DE "von der App gesetzt"), and never "started by you".
- Given a skill carried over from an earlier turn, Then behaviour is unchanged (not announced) until Q7 is decided.
- Verify: new server test for `announcedSkills` (`app` vs `user`), `chatTurn.test.js` frame, reducer test, chip test; the stored and share whitelists keep `app`.

**US-6 (M) Technical details behind a toggle.** As a user, I want plumbing arguments out of my way, and as an admin I want them one click away.
- Given an expanded timeline with the toggle off (default), Then no argument names or values such as `extractContent`, `maxLength`, `offset`, `limit` are visible; query, URL and titles still are.
- Given the toggle on, Then the arguments show as today, plus tool id and duration.
- Given the toggle, Then it is keyboard operable, `aria-pressed`, at least 24 px, and the page works when storage is unavailable.
- Given a shared chat, Then private calls still show no arguments regardless of the toggle.
- Verify: `tool-activity.test.jsx`.

**US-7 (M) Source cards name their origin.** As a user checking a claim, I want each source to say which system it lives in.
- Given sources from web, project, iFinder and Jira, Then each card's meta line starts with the origin icon and noun (Jira shows "Jira"), as text.
- Given a source stored before the change (no `origin`), Then the card is unchanged and nothing is inferred from `provider`.
- Given the same answer, Then the card's origin, the activity row's origin and the footer kind agree (consistency test).
- Verify: `answer-sources.test.jsx`, `answer-basis.test.jsx`, new consistency test on the server (`server/tests/answerBasis.test.js`).

**US-8 (M) Stored and shared chats stay safe.** As an owner sharing a chat, I must not leak names.
- Given a share containing project and iFinder calls, Then a viewer sees origin types (Project, iFinder) and no project name, profile name, arguments or private hits (today's rules); public web calls keep their hits.
- Given a chat stored before the release, Then it opens without error, rows have no origin words, and the stored/live display differ only by those missing labels.
- Given a reopened chat with a web search, Then the provider ("Brave Search") shows as it did live (closes O9; V1 first).
- Verify: `chat-persistence-activity.test.js`, a share test next to `ChatShareRepository`, `stored-run-activity.test.jsx`.

**US-9 (S) Footer and timeline do not disagree.** As a user, I want the footer and the line above the answer to name the same origins.
- Given the user pastes a URL and the model calls only `read_url`, Then the basis contains `web`, the footer names Web and the timeline shows one Web segment.
- Given a project search with no results plus a web answer, Then the timeline shows "Project · no matches", the footer shows Web only (not "Project"), as designed in `concepts/2026-11-12 ...`.
- Verify: `server/tests/answerBasis.test.js` (new case), `knowledgeSourceSeam` unit test.

**US-10 (C, Next) Origin filter in the Sources panel.** Given sources of more than one origin, Then filter pills (All, Web 5, Project 3) show and filter the cards; a single-origin answer shows none.

---

## 8. Scope slices

Sizes are relative (S/M/L), not durations. Server PR first (additive, invisible), then client PRs, which already tolerate a missing origin.

| Slice | Content | Server | Client | Size |
|---|---|---|---|---|
| **MVP-1 server/shared** | `activityOriginOf` in `toolDisplay.js` on `tool/started`, `args` frames, ledger `tool/call`; schemas; reducer (`argDisplayFields`, `TOOL_STARTED`); `buildToolActivity` item `origin`; stored and share whitelists; persist `integration` (O9); `activatedBy: 'app'` through `announcedSkills`, schema, reducer, store and share; `read_url` counted as web in the basis (O10); `Source.origin` from producers and its normalisation | yes (about 10 files) | shared reducer | M |
| **MVP-2 client activity** | Streaming headline with origin; per-origin segments; row grammar with origin words and icon; "no matches"; skill chip with who, `SkillRow` and skills count removed; Technical details toggle; EN/DE strings (about 20 to 25 keys); tests | none | `ToolActivity.jsx`, `activityHeadline.js`, `ChatMessage.jsx`, i18n | M |
| **MVP-3 client sources** | Origin label on source cards; tests; strings | none | `AnswerSources.jsx` | S |
| **MVP-4 docs** | Release note, docs (section 12) | none | none | S |
| **Next** | Origin filter in Sources panel (S); metrics M1 to M5 (S to M, server); instance names on rows (project name, iFinder profile) with share scrubbing (M); voice-mode wording from origin (S); carried-over skill indicator after Q7 (S to M); "Show thinking analysis" restyle as part of the activity disclosure family, the #3521 follow-up (M) | partly | partly | S to M each |
| **Later** | Optional "Group by origin" view toggle if research asks for it (M to L); remove `activityScope` and the stored `scope` (S to M, a deliberate breaking cleanup); origin declared on tool definitions (#3038) replacing the classifier (M); admin run-detail page on the same vocabulary (M) | yes | yes | mixed |

MVP in total is large but splits into three shippable PRs. No config migration is needed (CLAUDE.md migrations are for config files; this changes wire and stored message data only). No feature flag is needed; each PR degrades gracefully when the field is missing.

---

## 9. Success metrics

Principle: only measure what this product can instrument. No baselines are invented; where no counter exists today, the baseline is measured in the first weeks after release, not before.

| # | Metric | Type | Instrumentation | Target / reading |
|---|---|---|---|---|
| M1 | Origin coverage: share of search/fetch calls with no origin | Leading (quality gate) | New counter `ihub.tool.calls{origin, outcome}` where `knowledgeSourceSeam.postTool` already runs per call. `outcome` = results, empty, error. Labels are bounded (6 origins plus none; no tool ids) | 0 for built-in tools; any `none` on a search or fetch is a classifier gap |
| M2 | Timeline/footer mismatch: answers where an origin with results in the timeline is missing from `answerBasis` | Leading (consistency gate) | Computed at run end from rows and `answerBasis`; counter `ihub.answer.origin.mismatch` | 0; would have caught O10 |
| M3 | Mixed-origin share: answers with two or more kinds in `answerBasis` over answers with at least one non-model kind | Leading (sizes the problem; informs whether A's grouping could ever pay off) | From `run/ended.answerBasis` (already emitted); counter `ihub.answer.basis{kinds_bucket}` or an offline pass over stored messages | Descriptive; baseline after release |
| M4 | Empty-search rate per origin: `outcome=empty` over searches | Lagging (admin insight made visible by "no matches") | M1 counter | Descriptive; high project rate suggests projects not matching how people ask |
| M5 | Internal-source verification: Preview/Download requests per answer that has a private-origin source | Lagging (behaviour: do people verify?) | New counter `ihub.source.actions{provider, action}` on the existing `/api/integrations/:integration/files/...` route; denominator from M3 data | Direction after release only; external link opens are not observable server-side |
| M6 | Thumbs-down share (`ihub.feedback`) on mixed-origin vs single-origin answers, before and after | Lagging, noisy | Existing counter; needs the `kinds_bucket` label | Supporting evidence only |

Validation that is research, not telemetry (section 13): comprehension accuracy on "Did this answer use our documents?", measured before and after in the same script.

---

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Classifier gaps yield tools without origin | Rows look like today | Null is a valid state (no guess); M1 surfaces gaps; unit table of every tool class (`server/tests/loop/toolDisplay.test.js`) |
| Timeline and footer drift | The exact inconsistency being fixed returns | One classifier; M2; fix O10; consistency test |
| Private names leak in shares via origin | Compliance incident | Origin is a type, not a name; private calls keep kind only; project and profile names are Next with the `knowledgeScope` scrubbing precedent (`runActivity.js:581-590`); share test |
| i18n grammar in German (prepositions per origin) | Awkward strings | Whole-phrase strings per origin, not concatenated fragments; tech-writer review; key parity EN/DE |
| 320 px and layout churn while streaming | Regression in Outlook pane | Segments only append; wrap, no truncate; screenshot test at 320 px; axe baseline |
| Test churn (`tool-activity.test.jsx` has 1,732 lines; 7 headline assertions) | Slow PR | Headline assertions are few; rows tests largely untouched; add new cases, change 7 |
| Product owner expects groups and sees a flat list | Rejection late | Show a clickable mock of C next to A in the research round (section 13); keep "Group by origin" toggle as a named Later option |
| Removing the skill row loses "when was it loaded" | Small information loss | Accept; revisit via Q3 if research says otherwise |
| Over-trust: a "Project" label reads as "verified" | Wrong confidence | The AI-generated segment of the footer chip stays; wording says where it came from, never that it is correct |
| `read_url` basis fix changes some footers | Surprise for admins | Release note under fixes; small blast radius (URL-only answers) |
| Old Outlook/extension bundles ignore the new field | Cosmetic gap | Field is additive; they keep today's display |

---

## 11. Open decisions for the product owner

1. **Chats stored before the change: clean break or compat shim?** (CLAUDE.md requires your call.)
   What breaks with a clean break: old chats' collapsed line shows plain counts ("2 searches, 5 results") instead of "Searched the web / documents"; rows lose an origin icon they never had; old `skill` rows are not drawn (the chip comes from `activeSkills`, which old chats keep). Old app-set skills stay labelled "started by you". Nothing is lost that cannot be recomputed from a newer chat.
   Options: (a) clean break, (b) read-time mapping of `scope: 'web'` only (exact) while `documents` stays unlabeled, (c) server backfill of stored chats (rows have `toolId`, but integration definitions are needed; not recommended).
   **Recommendation: (a).** It matches your 2026-11-12 decision for the footer chip, the client must not guess (`documents` is ambiguous), and stored rows already lack the provider (O9).
2. **Raw tool arguments: behind "Technical details" for everyone, or only for admins?**
   **Recommendation: for everyone, default off.** Admin-only means two UIs and unreproducible screenshots; some arguments (filters, search profile) are legitimate transparency for compliance; shares already hide them for private calls; admins keep the run ledger for depth. Revisit admin-only only if an argument-exposure concern is raised.
3. **Where does a skill live: header chip, timeline row, or the footer popover?**
   **Recommendation: the header chip, with who in words.** A skill is how the answer was instructed, not an origin of information; the chip stays visible when the timeline is collapsed. Flip rule: if research shows people look for "what happened" in the timeline, move it there and name it in the summary instead.
4. **Keep `activityScope` on the wire after `activityOrigin` ships?**
   **Recommendation: keep it for this release, with no new consumer;** remove it later as a deliberate breaking cleanup (extension and Outlook bundles may be older than the server). Removing now would make cached clients draw every call as web.
5. **Fix the footer for answers whose only retrieval was `read_url`?** (O10; change of footer semantics.)
   **Recommendation: yes,** count it as Web; announce under fixes.
6. **Show project or iFinder-profile names on timeline rows?**
   **Recommendation: not in the MVP;** type only. Add in Next with share scrubbing. The footer popover already names projects.
7. **Show skills carried over from earlier turns on later answers?** (Today nothing shows; V3.)
   **Recommendation: decide after research;** not in the MVP. If shown, a quiet "Skill still active: X" in the chip row, not a new timeline entry.

---

## 12. Release-note and docs impact

Release notes (use `/document-feature`; never write into numbered release folders):
- `docs/releases/next/features.md`: "The Activity Line Says Where the Answer Looked" (origin segments, streaming wording, "no matches", Technical details toggle, one skill chip with who); "Sources Name Their Origin". State in one sentence that chats stored before the release show their activity without origin labels (clean break, if Q1 = a).
- `docs/releases/next/fixes.md`: skills set up by an app no longer read "started by you"; reopened chats keep the search provider name (only if V1 confirms); an answer based on a page the model read is marked Web, not "Model knowledge" (only if V2 confirms).
- `docs/releases/next/breaking-changes.md`: none for APIs (all additive). Put it there only if you prefer to flag the stored-chat behaviour.

Docs to update (existing topic files first, per CLAUDE.md; none of these needs a new file, so `SUMMARY.md` is unaffected):
- `docs/answer-sources.md`: "What users see" (the activity line sentence "How the answer searched stays above it (Searched the web · 1 search · 10 results)"); "The model" table gets `origin`; the "On the wire" section.
- `docs/web-tools.md#sources-and-citations`: same activity sentence.
- `docs/chat-persistence.md` ("What a turn did", about line 877-907): activity item shape, `activatedBy: 'user'|'model'|'app'`, the single skill home.
- `docs/skills.md:34`: "Used skill row" becomes the chip with who; add "set by the app".
- `docs/sse-v2.md` (about lines 71 and 102): `activityOrigin` on `tool/started`, `args`, ledger.
- `docs/accessibility.md`: one line if the Technical details toggle becomes a documented pattern.
- Strings: `shared/i18n/en.json` and `shared/i18n/de.json` under `toolActivity.*`, `sources.*`; origin nouns reuse `chatMessage.answerBasis.kind.*` (no new nouns).
- Concept doc: this brief moves to `concepts/activity-origin/` (folder with `README.md` if three or more related documents result, per CLAUDE.md).

---

## 13. Research and validation plan (to run before the build is finalised)

This is a plan, not evidence. Run in German with knowledge workers and two admins.
- Stimuli: today's screenshot, a prototype of C, a prototype of A, both on a mixed web and project run and on a project-only run.
- Tasks (same script for each stimulus): "Did this answer use your company's documents?"; "Did your question go to the public web? To whom?"; "Why does the answer not mention your project?"; "Which skill shaped this answer and who started it?"; admin: "Which argument limited the page read?".
- Read: comprehension accuracy and time per task, preferred layout, and whether participants look at the timeline order or the per-origin totals.
- Decision rules (no invented numbers): if A beats C on the mixed-run tasks for most participants, move "Group by origin" from Later to Next; if participants look to the timeline for the skill, flip Q3; if "Did your question go to the public web?" is a real concern (A3), prioritise provider and query visibility in the rows.

---

## 14. Handoff: how to continue (for a junior)

Read in this order: `00-fact-base.md`, this brief, `concepts/2026-11-12 Answer Footer Basis Chip.md`, `docs/answer-sources.md`, `docs/run-ledger.md`.

First verify V1 to V3 (30 minutes each, no code changes):
- V1 Reopen a chat after a web search: is the "Brave Search" chip and the provider tail gone? (O9)
- V2 Paste a URL, let the model call only `read_url`: is the footer "Model knowledge"? (O10)
- V3 Does any UI show a skill that carried over from an earlier turn? (O8)

Then build in this order:
1. `server/utils/toolDisplay.js`: add `activityOriginOf`, call it from `toolDisplayOf` and `startedDisplayOf`; extend the schemas in `server/services/loop/contracts/sseV2.js` (`toolStartedData`, the `args` progress data) and `runLogEvents.js` (`toolCallData`).
2. `shared/run/runReducer.js` (`argDisplayFields`, `TOOL_STARTED`) and `shared/run/toolActivity.js` (`callRow`, `nativeSearchRow`): carry `origin` into the row.
3. `server/services/chat/runActivity.js`: add `origin` and `integration` to `boundToolItem`, `origin` to `shareableActivity` (kind only for private calls).
4. `server/routes/chat/sessionRoutes.js` (`announcedSkills`) plus the `activatedBy` enums (schema, reducer, `boundStoredActivity.activeSkills`): add `app`.
5. `server/services/loop/seams/knowledgeSourceSeam.js`: classify `read_url` as `websearch`; update `server/tests/answerBasis.test.js`.
6. `server/services/sources/producers/*` and `shared/sources/source.js`: set and normalise `Source.origin`.
7. Client: `activityHeadline.js` (`searchLabel`, `activeLabel`, `searchedParts`, `finishedHeadline`, `lookedAtIcon`), `ToolActivity.jsx` (segments, row grammar, details toggle, remove `SkillRow`), `ChatMessage.jsx:971-985` (chip with who), `AnswerSources.jsx` `SourceCard` (origin label), `shared/i18n/{en,de}.json`.
8. Tests listed under each story; run `npm run lint:fix && npm run format:fix`; add the SPDX header to any new file.
9. Docs and release note as in section 12.

Questions to hand to the other reviewers:
- UX: wrap and truncation rules for segments; where the Technical details toggle sits; chip layout at 320 px; row grammar when a hit list is long.
- UI: the leading-slot rule (status icon vs origin icon); icon for `documents` and `integration` rows; segment spacing; dark mode contrast.
- Research: section 13.
