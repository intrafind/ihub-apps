# UI/UX Brief: Origin-aware activity, skills and sources

| | |
|---|---|
| Document | 03 UX brief: structure arbitration, interaction design, copy, accessibility |
| Author role | Senior UX designer (transparency and provenance UX, WCAG 2.2 AA) |
| Date | 2026-11-13 |
| Status | Draft for product-owner, UI-designer and tech-lead review. No source file was edited, nothing was run. |
| Reads with | `00-fact-base.md`, `01-research.md` (F1-F18), `02-product-brief.md` (sections 0, 4-7, 11) |
| Location | `concepts/2026-11-13 Activity origin/03-ux-brief.md` |

How to read this: section 0 is the verdict. Section 1 is the decision log (what, why, what was rejected). Section 2 is the fixture walk-through that decides the structure question. Sections 3-6 are wireframes, the state matrix, the copy table and the accessibility spec. Section 7 lists server data the PM contract does not yet carry. Section 8 is what to test with real people. Section 9 is the handoff for whoever builds it.

Evidence rules (same as the research): **O** = observed in the screenshot or in code I read (path:line). **J** = my design judgment. **C** = a calculation, not a measurement. Scores in section 2 are judgment, not data. German strings are expert judgment and need native-speaker review. I am not a user and nothing here is user data.

---

## 0. Verdict in one screen

**Structure of the expanded list: Option C (flat, chronological, origin in words on every row), refined. Not A, not A-prime.** Fallback: A-prime, as a renderer-only switch (the data contract is identical, so choosing C now costs nothing if validation says otherwise).

Three reasons it wins:

1. **The expanded list is everyone's live view.** `open = expanded ?? loading` (`ToolActivity.jsx:68-69`): the list is open for every user, every turn, while it streams. The PM did not cite this, and it changes the weighing: weight and stability while streaming are mass-market criteria, not admin criteria. C adds no line to the single-origin web run (F6, the common case) and never moves a painted row. Any sectioned design adds one header line to F6 and one per origin change, always.
2. **A section header duplicates the collapsed line that stays on screen directly above it.** When the list is open the headline button (one segment per origin: icon, noun, counts, provider) is still the first thing the reader sees. A-prime's headers (Web, Project, Web) would repeat it one line below. The per-origin totals the owner wants live in the headline; the per-call proof lives in rows that name their origin.
3. **Sections break on the agentic run (F3).** Jira, Munich AD and a PDF creator are not retrieval origins with hits and reads. A gets four headers for five rows; A-prime must leave them flat, so the list has two grammars and the headline names origins that have no header.

What the owner's idea gets right and C keeps: origin unmistakable (icon + noun in every row's phrase), provider at the end of its own search row ("via Brave Search"), hits inside their search, per-origin totals with the provider at the end (headline segments). What it loses on honestly: **on the owner's own screenshot (F1) A-prime beats C on one thing**: the three page reads are structurally separated from the project search, whereas in a flat list they still sit directly under it (C relies on a globe icon and "Opened web page" to say otherwise). C closes that gap in the later merge step (a page is shown once, on its hit); until then it is a residual risk that section 8 tests.

PM objections, scored honestly: valid against A (reorders, lies about order while streaming, needs an "Other" group, F3 explodes); **overstated against A-prime** (A-prime handles web-project-web by design with three sections and only appends, so the "breaks on interleaving" and "layout churn" objections do not hold for it; its real cost is header weight and the F3 grammar split). "Cost most" is true for A and only moderately true for A-prime (same data, different renderer); my recommendation does not rest on cost.

Other decisions in one line each (details in section 1): the skill appears **once, in the activity block (a row in the list and a leading segment in the collapsed line), always with who in plain words** (started manually / chosen by the model / set by the app / kept from an earlier message); the first version of this brief used a header chip, and the product owner moved it into the activity block on 2026-11-13 (D1); **"Read" is retired**: the hit-level eye marker goes, page reads become "Opened web page" rows, the headline counts "N opened" (the later merge shows a page once); **Technical details** is a switch at the top of the open list, finished turns only, off by default, remembered, applies to all messages; the reasoning disclosure is renamed **"Thinking process" / "Denkprozess"** (the product's own settings vocabulary) and given the same shape and `aria-expanded` as the activity line; no actor is ever shown on search or read rows.

Corrections to inputs: (a) German register is formal, confirmed (my count over `de.json` values: about 986 strings with Sie/Ihr-forms against 22 with du-forms, consistent with the 970/23 you gave); the PM's informal-du copy is replaced. (b) The brief's premise that carried-over skills "show nowhere but the header pill" is not confirmed by the code: the pill is built from `run.skills`, which is folded only from `skill.activation` frames (`shared/run/runReducer.js:529-532`), and carried skills emit no frame (`announcedSkills`, `sessionRoutes.js:134-137`). Per my reading they show nowhere at all (same as PM verification item V3; verify).

---

## 1. Decision log

Format: decision, reason, rejected alternative, and where it matters, what would make me change my mind.

### D0. Structure of the expanded activity list

**Decision.** Option C, refined: one flat `<ol>` in time order; every search and read row names its origin in its own phrase (whole phrase per origin, icon + noun, never colour); the provider sits at the end of the search row as visible text ("via Brave Search"); an empty search says "no results"; hits stay nested under their search; page reads are rows that carry the web icon and the words "Opened web page" (merged into hits later, see D2); plain calls (connected systems, creators) are unchanged rows. The collapsed line is one segment per origin (section 3.1). Reads of the same origin sit visually next to each other only because they happen next to each other; no regrouping, ever.

**Reasons (evidence in section 2).**
- Streaming default: the list is open for everyone (O: `ToolActivity.jsx:68-69`), so what it costs and whether it moves while streaming matters for every turn.
- Rows only append and change text in place. Origin ships on the first frame that creates the row (`args` progress, `tool/started`; PM contract section 4), so a row never changes parent.
- The per-origin summary already sits directly above the open list.
- One grammar for every row kind, including connected systems and creators, so the headline and the list always agree.
- Same data as A-prime: nothing in the contract changes if we later switch the renderer.

**Rejected.**
- **A (groups by origin type, regrouped).** Loses on F2 (the project search is shown after both web searches although it ran between them), F3 (a header per one-call system) and F4 (a new web call inserts itself into the earlier web group and pushes the project group down; a row painted before its origin is known moves). Only wins where nothing else is going on (F5 ties).
- **A-prime (sections in run order).** Honest and append-only; loses weight on the common case (F6 +1 line, always: it cannot omit the header for a single origin without inserting it later when a second origin joins, which is exactly the churn we avoid), loses weight at 320 px (one more indent level: hit titles wrap more, about 5 lines on F1 in German; section 2.3), and splits into two grammars on F3 (section for iFinder, loose rows for Jira, Munich AD and the PDF). Wins on F1 for the false-hierarchy misread, until the merge ships.
- **Origin icon in a left gutter on the first row of a same-origin run** (A-prime without the noun): breaks "icon + noun" (#3619) and the screen reader needs the noun in every row anyway.
- **"Group by origin" view toggle**: Later, only if validation shows people scan by origin (PM section 13). Not now.

**Change my mind if** (falsifiable, section 8): in the F1 task "Which origin did the three page openings come from?" fewer than 5 of 6 participants answer "web" with the flat list. Then ship A-prime sections for the expanded list, behind a flag, with no server change.

### D1. Skill: one home, one rule

**Revision 2026-11-13 (product-owner decision).** The first version of this brief put the skill in a header chip. The product owner asked for one place that shows what happened, and the skill now lives in the activity block. This section is the revised rule; the first version's reasoning is kept under "Rejected" so the trade-off stays visible. Wherever this brief still says "chip" for a skill, read "skill row and headline segment"; the passages that matter have been changed.

**Decision.** A skill that shaped the answer appears **exactly once, in the activity block**. It is never a header chip and never a chip plus a row.

- **Expanded list:** one row per distinct skill in the flat, time-ordered list. Skills in force from the start (started manually, set by the app, kept from an earlier message) are the first rows. A skill the model chooses appears where it happened. Rows only append while streaming.
- **Collapsed line:** skills come first, as segments in the same grammar as the origin segments: `[skill] Skill: Contract review · started manually`. One or two skills: a segment each, with the reason. Three or more: one segment `Skills: A, B, C`, names only (the reasons are in the expanded rows). Skills are not origins, so they do not count against the limit of two named origins.
- **A turn with a skill and no search or tool call** still gets the activity block: collapsed it is the skill segment, expanded it is one row.
- **Header block order:** Thinking process, then the activity block, then the answer.

The row and the segment say what it is and who brought it in, always, in plain words:

| Route on the server (O: `skillAccess.js:571-640`, `sessionRoutes.js:134-143`) | Wire value (`activatedBy`) | EN | DE |
|---|---|---|---|
| Picked in the composer (`requested`) or typed `/name` (`message`) | `user` | Skill: Contract review, started manually | Skill: Vertragsprüfung, manuell gestartet |
| The model calls `activate_skill` | `model` | ... chosen by the model | ... vom Modell ausgewählt |
| The app's `skillSettings.autoActivate` (`app`) | `app` (new; today mislabeled `user`) | ... set by the app | ... von der App festgelegt |
| Active from an earlier turn (`chat`) | `chat` (new; today emits no frame) | ... kept from an earlier message | ... aus früherer Nachricht übernommen |
| Actor unknown (answers stored before the change) | none | name only, no suffix, nothing guessed | Name ohne Zusatz |

Rules:
- If the same skill came in by several routes, the earliest and most explicit wins: user over app over model (extends `foldSkill`, `runReducer.js:261-277`, which today has user over model).
- One row per distinct skill. The model loading a skill twice is one row, at its first activation.
- The visible separator between name and reason is a middle dot; a screen reader hears a comma (visually hidden).
- The row is static text in the normal row grammar: not focusable, no outline, no `title`. It carries the noun "Skill:" so it cannot be mistaken for the app name or a mode (F9). Icon: the UI designer must not reuse `sparkles` (the footer's AI segment reserves it, `answerBasisModel.js:17-33`).
- The wording is person-neutral on purpose: no "you", no "du", no "Sie". A shared read-only chat is read by someone who did not start the skill, so "started by you" is false there (the old `SkillRow` has no read-only branch, `ToolActivity.jsx:228-251`); the DE register problem disappears; one string per state, no `readOnly` branching.
- Carried-over skills: **show them** (same row, "kept from an earlier message"). A rule with a hole ("every skill that shaped this answer, except the ones from earlier turns") is the original bug in a new place. This needs the server to announce them (section 7, G4). If the PO defers it (PM question 7), ship the other four states and say in the release note that a skill kept from an earlier message is not shown yet.
- There is no single default route, so the row always carries its reason and nothing has to be inferred from absence.

**Reason.** The user's complaint ("sometimes a chip on top, sometimes also in the thought chain") has a precise cause in code: the chip and the row are two renderings of the same `skill.activation` frame, and the rows exist only for skills with a frame (O). The product owner's fix is one place, and the activity block is the place that already answers "what happened". The objections to putting a skill there are answered like this:
- *A skill is a state of the whole answer, not a step.* A skill in force from the start is the first row, at time zero. The list stays a log of what the answer used.
- *It must stay visible when the list is collapsed.* The leading headline segment does that.
- *It must not compete with the origin segments.* It leads, and it uses the same grammar, so the line stays one grammar.
- *The header block gets lighter.* Three stacked things above the answer (chips, Thinking process, activity line) become two.

**Costs.**
- The collapsed line is one segment longer and wraps.
- A skill with no step sits first rather than at a time; the reason text ("set by the app", "kept from an earlier message") is what tells the reader it was in force from the start.
- With three or more skills the collapsed line does not show who started each one (to validate, section 8, V3).
- App-set and carried-over skills still need the new server frames (G4).
- A skill-only answer now carries an activity block it did not have before (to validate).
- A chat-launched workflow keeps its own indicator above the answer. Workflows are not in the timeline today (`shared/run/toolActivity.js` leaves them out); merging them is a separate redesign.

**Rejected.**
- *Header chip (this brief's first version).* Visible when collapsed and independent of the list, but a third element above the answer and a second home for the same fact, which is the confusion the owner reported.
- *Researcher: "actor only when exceptional".* Absence of a label is ambiguous (model or app? carried?), so the row always carries its reason.
- *PM: "started by you / loaded by the model" wording.* "You" is wrong in shares; "loaded" is engineering vocabulary (research section 4); "von dir" is the wrong register.
- *A row that is a button opening an explanation.* Scope creep, and it turns provenance into a control (outlined = clickable, #3619).

**Risks.** (1) An app that auto-activates a skill shows the same row on every answer; habituation is possible (validate, section 8). (2) A model-chosen skill appends a row mid-list; it only appends, so nothing above it moves.

### D2. "Read": retire the word, show a page once

**Decision (minimal coherent fix).**

MVP:
1. **Remove the hit-level markers, both the green eye "Read" and the amber "Not readable"** (`SourceRow`, `ToolActivity.jsx:567-587`). A failed open is the read row's own Failed state. The green eye meant "the provider returned an extract" (`web.js:204`), an iFinder document that was opened (`resolveDocuments`, `toolActivity.js:75-98`) or a page that was fetched, and it was drawn in the same colour and word for all three.
2. **Page and document reads become rows named by origin and verb "Opened"**: "Opened web page", "Opened document in the project", "Opened document in iFinder" (live: "Opening <host>"). Lead icon is the origin icon (globe for web), not a document glyph.
3. **The headline counts only openings**: "3 opened" per origin. "5 pages read" and the "Seiten" false friend disappear. "N opened" counts a `kind: 'fetch'` row only when it succeeded: its status is `completed`, it did not hit the page-read limit (`limitReached`), and its source did not report `read.ok === false` (the flag behind today's "Not readable"). A failed, stopped or limit-reached fetch is not counted as opened; it is counted in "N failed" or shown as "Not opened" (section 4.1). All three signals are already on the row and come from the server's tool outcome, so nothing is inferred from a tool id. A fetch can complete without delivering any text: `read_url` with `offset` at or past the end of the page makes `sliceDocument` return an empty `content` (`server/services/pageReader/pageContent.js`), and the web producer still reports `read.ok: true` (`server/services/sources/producers/web.js`). Those reads must not count as opened, so the server declares the outcome (section 7, G10, MVP) and the tests need an offset-at-end fixture.
4. **"partly read" replaces the amber "truncated"**, visible neutral text next to the row, no tooltip (F15). Word counts ("1,334 words") move into Technical details.
5. The provider extract (the `extractContent` text) is not marked in the default view. It appears only in Technical details if the server sends its depth (section 7, G6, Later).
6. The panel section "Read for this answer" stays as is. It is a different axis (role in the answer: cited / read / considered) and it counts everything the model had text for, including extracts. The headline's "3 opened" and the panel's "Read (5)" can differ on the screenshot run; section 8 tests whether that confuses anyone.

Later (needs no new server data, only stable-rendering care): **merge hit and read so a page is shown once.** A fetch whose source id matches a hit of an earlier search in the same turn does not get its own row; its hit shows the state inline ("Opening..." then "Opened · partly read"). Stability rule: the decision is taken when the fetch row would first paint (its URL is known from the arguments, which are tiny); a row that has been painted is never removed. A fetch with no matching hit (a URL the user pasted) stays a row. In the screenshot run the three read rows would disappear: all three are hits of the web search (O), and the project row would be last with nothing under it.

**Reason.** Users read "Read" as an inbox read-state (research F6, DE concern), the number never reconciled (5 vs 3), and the three meanings overstate evidence on a trust question. Removing the marker is cheaper and clearer than relabeling it "Excerpt" five times in a row, and the researcher's own hypothesis H4 says depth rarely matters to non-admins.

**Rejected.** (a) "Opened" vs "Excerpt" markers on every hit now: adds a new word that has to be tested, repeated five times in the screenshot, for a distinction most readers do not need. Keep as the fallback if the label test shows people ask "did it read the others?". (b) "Read for this answer" renamed in the panel: it is correct on its axis. (c) Doing the merge in the MVP: the merge is a row that disappears or an inline mutation; it needs the stability rule above and its own test.

**Label risk (J, untested).** "Opened" could read as "opened in my browser". German alternatives to test: "geöffnet" (primary), "abgerufen". The product already says "Seitenaufrufe" for the fetch limit (`toolActivity.pageReadLimit`), so "aufgerufen" is also a candidate.

### D3. Raw tool arguments: "Technical details" switch

**Decision.**
- **Placement.** Directly under the headline, above the first row, only while the list is open **and the turn is finished** and at least one row has technical details. Not at the end of the list (PM): the end moves while the list grows, it is out of sight on long lists, and the effect of toggling happens above the control. Not while streaming: the list is open for everyone then and the control would cost every user a line for a minority.
- **Control.** `role="switch"` with `aria-checked`, constant label "Technical details" / "Technische Details", minimum 24 px high, focus ring like the headline. A switch, not `aria-pressed` (PM): it is a remembered preference that applies to every message, which is a setting.
- **Scope of the preference.** Global per browser, applies to all open lists on the page at once (one small external store with subscribe; read and written inside try/catch; if storage is unavailable the choice lives in memory for the session and the page works).
- **Default off. Everyone, no admin gating** (agree with PM: two UIs make screenshots undebuggable).

| Always visible (switch off) | Only when the switch is on |
|---|---|
| Query chip, URL or title, host, hit titles and links | Argument names and values (`extractContent`, `maxResults`, `contentMaxLength`, `maxLength`, `offset`, `limit`, filters) |
| Result count or "no results", "partly read", "Failed" with its reason | Tool name (the id the model called) |
| Provider ("via Brave Search"), occurrence ("No. 2") | Duration |
| The sentence for "Not opened" (page-read limit reached) | Words read ("1,334 words") |
| | Provider extract depth, if the server sends it (Later) |

- **Screen readers.** Name "Technical details", role switch, state announced natively on toggle; hint via `aria-describedby` ("Shows each step's tool, arguments and duration"). Toggling does not move focus and is not announced by `RunAnnouncer`. The details are plain `<dl>` content inside the row (existing structure), so they are read with the row when on.
- **Shared chats.** Private calls carry no details, and the shared payload stays as is (`runActivity.js:547-575`); if no row has details the control is not rendered.

**Rejected.** Admin-only (two UIs); end-of-list placement; always-on chips (F8); tooltips for the tool id (`ToolLabel` puts the id only in `title`, `ToolActivity.jsx:389-408`: nothing is only in `title`, so the id moves here).

### D4. "Show thinking analysis": the minimum to make two disclosures one family

**Decision.** Three small changes, one fallback, one separate ticket.
1. **Rename.** EN "Thinking process", DE "Denkprozess". Drop the show/hide verbs: state is carried by the chevron and `aria-expanded`, exactly as the activity line does it.
2. **Same affordance.** Use the activity button's own classes: light-bulb icon (already the icon of the "Thinking..." idle line, `ToolActivity.jsx:143-146`), label, chevron, focus ring. Add `aria-expanded` and `aria-controls` (today the plain underlined button exposes no state: WCAG 4.1.2, `ChatMessage.jsx:1000`; that part is a defect fix, not a restyle).
3. **Order.** Thinking process, then the activity block (which holds the skill rows), then the answer (revised 2026-11-13: the skill chips above them are gone, see D1). Reasoning first because it is usually first in time; both lines are appended in that order, so neither pushes the other. Putting the activity first would insert the reasoning line above it when thoughts arrive later.

**Reason for "Thinking process" over the researcher's "Reasoning / Gedankengang".** The product already has this vocabulary in the setting that switches the disclosure on: EN "Show thinking process" (`en.json:6907`), DE "Denkprozess anzeigen" (`de.json:668`), "Denkmodus aktivieren", the idle line "Thinking... / Denkt nach...". The message link is the only outlier ("thinking analysis"). "Reasoning" is also already taken in the admin UI as a model-capability label (`de.json:1809`, `"thinking": "Reasoning"`), so it would mean two things. Reusing existing words adds none. I am deviating from the researcher and from the example in the task; "Reasoning / Gedankengang" stays in the label test as the alternative.

**Fallback if the PM holds the "no restyle" line.** Do 1 and the `aria-expanded` part of 2 only (zero visual change except the words). The family then rests on parallel labels alone.

**Separate ticket.** Merging both disclosures into one "How this answer was made" block is a real redesign (the #3521 follow-up). Not in this slice.

### D5. Sources panel: origin on every card, filter next

**Decision.**
- **MVP: the origin noun is text on every card**, the first token of the meta line: `Web · intrafind.com · 12 Nov`, `Project · Project Alpha`, `iFinder · [scope chip]`, `Jira`, `Document sources · <name>`. Same nouns as the footer (`chatMessage.answerBasis.kind.*`), plus the integration label for connected systems. **No origin glyph on cards in the MVP**: the card's leading icon already encodes the thing (favicon or initial, file icon, cube), and three of the six origin glyphs collide with icons already on the card (iFinder `document-text` = the file icon, Project `folder` = the scope chip's icon, `link`). Noun-only avoids it and is still icon-free text a screen reader reads.
- **A project document differs from an iFinder document by noun and by what follows it**: Project shows the project name (it is already `site`, `producers/project.js:51`) and the provenance line ("Uploaded", "Picked from ...", "Linked"); iFinder shows its search-profile chip. Both keep the file icon.
- **Panel header for mixed origins.** Title stays "Sources" (the panel lists cited, read and considered sources; "results" is the tile's word, #3521). With two or more origins, a one-line summary sits under the title: `Web 5 · Project 3`, built from the same per-origin entries as the footer. In MVP it is plain text (a list, not buttons). In Next the same line becomes filter pills (outlined = clickable). One origin: no summary line; the cards say it.
- **Relation to Cited / Read / Considered.** Two orthogonal axes: role in the answer (the three sections, unchanged, primary) and origin (label now, filter next). The origin filter narrows all three sections.
- **Relation to `ScopeFilter`** (iFinder search profile, `AnswerSources.jsx:791`): it becomes a second level under the iFinder origin. One row of pills at a time: origin pills when two or more origins; choosing iFinder reveals the profile pills; an answer with only iFinder sources and two or more profiles shows the profile pills as today.
- A source without `origin` (answers stored before the change): card unchanged, nothing inferred from `provider`.

**Rejected.** Origin as a coloured chip (#3619); the origin glyph now (collisions above); replacing Cited/Read/Considered with origin groups (hides the "what did the answer rest on" axis users already use).

**Flag for the UI designer.** The scope chip uses `folder` for an iFinder search profile (`AnswerSources.jsx:924`) while the footer uses `folder` for Project (research F12). Pick a different glyph for the profile chip when the origin filter lands.

### D6. "Who triggered it" on search rows

**Decision.** Search and read rows never show an actor. The model decides every search call; "by the model" on every row is noise (research F10, PM A4). The user never "forces a call": the web-search toggle and an attached project enable a **scope** (what the model may use), they do not trigger a call. The server holds that scope fact at request time (`enabledTools` against `appDefaultEnabledTools(app)`, `RequestBuilder.js:725`) but does not put it on any run event, so the UI has nothing true to say today.

Out of scope for this slice: a sentence such as "Web search was switched on by you / by the app". Its one coherent home is the footer's "About this answer" popover (scope, not step), needs a new server field (G7) and is Later. The only actor the UI shows is on skills (D1).

**Rejected.** An actor chip per row; guessing "you asked for this" from the user's message text.

### D7. Streaming, states, focus (summary; details in sections 4 and 6)

**Decision.**
- While a call runs the headline names the origin and the query, from whole phrases per origin (EN/DE in section 5). The origin is in the words, never only in an icon: while a spinner leads, and for failed and awaiting states, the status icon wins the leading slot (`StatusIcon`, `ToolActivity.jsx:194-215`).
- Unknown origin (older server, unclassified tool) shows a neutral generic phrase, never a guess. Today the code defaults to web when `scope` is not `documents` (`activityHeadline.js:188-190, 200-203`); that default goes.
- "no results" is a **server-declared** outcome, never `sources.length === 0`. A provider-run web search row has no sources by construction (`toolActivity.js:404-422`), so inferring "no results" from an empty list would be wrong exactly there.
- Empty search = neutral grey text; failed = red text plus its reason line; stopped = grey; "partly read" = neutral; "Not opened" (page-read limit) = amber with its sentence. No state relies on colour: each has its own words.
- Screen readers: `RunAnnouncer` already speaks `activeLabel` at call start (`deriveAnnouncements.js:101-115`), so the origin phrase is spoken for free; new: one polite announcement when a search ends with a declared zero count; no end-of-turn summary announcement (the footer chip's label already names the basis). No ticking numbers anywhere in the new strings.
- Layout: finished headline wraps, never truncates (today `truncate`, `ToolActivity.jsx:82-91`); hit titles wrap to two lines instead of `truncate` (`SourceRow`, `ToolActivity.jsx:554`), because the full title exists only in `title` today; every new or touched control is at least 24 px; nothing exists only in a `title` tooltip.
- **New focus rule.** When the list closes by itself at the end of a turn while focus is inside it, focus moves to the headline button. Today the list unmounts and focus falls back to the document (O: `open = expanded ?? loading`, list rendered only when open).

### D8. Copy

**Decision.** One string per origin and role, whole phrases (section 5). German is formal or impersonal throughout; the PM's informal-du premise is wrong (section 5.8 lists the existing du outliers). Prepositions are inside each phrase ("Im Web gesucht nach", "In iFinder gesucht nach"); the query is the trailing slot in both languages, so the query chip can follow the phrase.

Deliberate deviations from the PM's working copy, for traceability:

| PM draft | This brief | Why |
|---|---|---|
| "Searching project documents for..." | "Searching the project for..." / "Durchsucht das Projekt nach..." | "documents" must never describe a project search (research F2/F12); a bare "documents" also reads as "all my files" |
| DE "Im Web gesucht wird nach" | "Durchsucht das Web nach" | The passive is awkward; the live strings in `de.json` are verb-first ("Sucht nach", "Liest {{host}}") |
| "no matches" / "keine Treffer" | "no results" / "keine Ergebnisse" | "results" is the decided noun (#3521) and the DE count already says "Ergebnisse" |
| "N pages read" / provider last, bare | "N opened", "via Brave Search" | D2; a bare provider name reads as another metric (F3) |
| "started by you / loaded by the model" | "started manually / chosen by the model" | D1 |
| Document kind noun "Documents" | "Document sources" (one deliberate divergence from the footer) | The only origin whose bare noun is the false friend; PO decision O-1 below |
| `aria-pressed` toggle at the end | switch at the top, finished only | D3 |

---

## 2. Fixture comparison

Options compared (the collapsed line is identical in all three: per-origin segments. The disagreement is only the expanded list):
- **A**: one group per origin, rows regrouped, ordered by first use, plain calls in an "Other" group.
- **A-prime**: sections in run order; a header (origin icon, noun, provider) is appended whenever the origin of the next call changes; plain calls and creators stay flat outside sections.
- **C**: flat, chronological, origin in every row's phrase.

Scoring: 1 (poor) to 5 (excellent), four criteria, each a judgment (J) with the reason in the notes.
O = origin legibility per call. S = story honesty (order truthful, no false parent/child). T = stability while streaming (nothing reorders or re-parents; only appends). W = weight (lines added to today's list; at desktop and at 320 px in German).

### 2.1 Fixture definitions

| ID | What it is |
|---|---|
| F1 | The screenshot run: web search (5 hits with extracted content), project search (returns nothing, or returns hits; research F7 says unverified), 3 web page reads after the project search. |
| F2 | Interleaved: web search, project search, web search. |
| F3 | Agentic: iFinder search, 2 Jira calls, a Munich AD people search, a PDF creator. |
| F4 | Streaming: origin unknown until the call arrives, then a second origin joins mid-answer. |
| F5 | Project search with zero hits, then web fallback ("why was it thin"). |
| F6 | Single origin, web only (the common case; it must not get heavier). |

### 2.2 Walk-through (desktop wireframes; 320 px German in 2.3)

**F1, three renderings of the same run** (hits abbreviated; MVP, so reads are still rows in C):

```
A (groups; reads move up into Web, above Project)
 [g] Web . Brave Search
    Searched for [IntraFind iFinder6] . 5 results
       hit x5
    Opened web page ... x3          <- these ran AFTER the project search
 [f] Project
    Searched for [iFinder6] . no results

A-prime (sections in run order)
 [g] Web . Brave Search
    Searched for [IntraFind iFinder6] . 5 results
       hit x5
 [f] Project
    Searched for [iFinder6] . no results
 [g] Web                             <- header repeated, reads under it
    Opened page ... x3

C (flat; origin in every row)
 [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
       hit x5
 [f] Searched the project for [iFinder6] . no results
 [g] Opened web page ... . partly read
 [g] Opened web page ...
 [g] Opened web page ...
 (after the later merge: the three read rows are gone, folded into hits 1, 3 and 5)
```

**F2:**

```
A:        Web {search 1, search 3}   Project {search 2}     <- search 2 ran between 1 and 3
A-prime:  Web {search 1} / Project {search 2} / Web {search 3}    <- three headers, order true
C:        [g] search 1   [f] search 2   [g] search 3           <- three rows, order true
```

**F3:**

```
A:        iFinder {search} / Jira {2 calls} / Munich AD {1 call} / Created {PDF}   4 headers, 5 rows
A-prime:  iFinder {search}   [k] Jira call   [k] Jira call   [k] Munich AD   [d] PDF   1 header, headline names 3 origins
C:        [i] Searched iFinder ...   [k] Jira call   [k] Jira call   [k] Munich AD   [d] Created PDF   5 rows
```

**F4 (streaming).** A moves or inserts rows when an origin becomes known or a second web call arrives; A-prime appends a header (and, only for a row painted before its origin was known, would re-parent it once; the PM contract puts origin on the `args` frame and `tool/started`, so this is rare); C changes text in place and appends rows. Frame-by-frame sequence in section 3.3.

**F5:** all three tell the story ("project: no results, then web"); A and A-prime put "no results" under a Project header, C on the Project row.

**F6:** A and A-prime add one header line above the one search row (always: omitting it for a single origin and inserting it when a second origin joins is the churn F4 forbids); C adds none and is lighter than today because the argument chips are gone.

### 2.3 Scores

| Fixture (weight) | A: O S T W = total | A-prime: O S T W = total | C: O S T W = total | Winner and the reason |
|---|---|---|---|---|
| F1 screenshot (x2) | 5 4 2 3 = **14** | 5 5 4 2 = **16** | 4 3 5 4 = **16** (S = 5 after merge: **18**) | Tie, A-prime ahead until the merge ships. Honest: A-prime removes the false parent/child structurally; C relies on icon and "Opened web page". |
| F2 interleaved | 5 2 1 3 = **11** | 5 5 4 2 = **16** | 5 5 5 4 = **19** | C. A reorders and misstates the order. A-prime is correct but pays three headers. |
| F3 agentic | 4 4 3 1 = **12** | 3 4 4 3 = **14** | 5 5 5 4 = **19** | C. A: header per 1-2 calls. A-prime: two grammars, headline names origins the list has no header for. |
| F4 streaming | 4 4 1 3 = **12** | 4 5 3 2 = **14** | 4 5 5 4 = **18** | C. A moves rows. A-prime is mostly stable. |
| F5 project empty, web fallback | 5 5 4 3 = **17** | 5 5 5 3 = **18** | 5 5 5 4 = **19** | Tie; all tell the story. |
| F6 single web (x2) | 5 5 5 2 = **17** | 5 5 5 2 = **17** | 5 5 5 5 = **20** | C. The common case; +1 line for sections. |
| **Total, unweighted** | 83 | 95 | **111** | |
| **Total, F1 and F6 counted twice** | 114 | 128 | **147** | |

Notes on the scores:
- O for C on F1 is 4, not 5: the read rows say "web" only through icon and the word "web page", not through a header.
- T for A on F2 and F4 is 1: a later web call is inserted into the earlier web group, above the project group (reorder), and a row whose origin arrives late moves.
- W for A-prime is 2 where origins alternate: one header per change.

Estimated lines at 320 px in German (C = calculation, not measurement; assumptions: about 43 characters per line in the list, 38 in hits, 12 px text, hit titles clamped to two lines, F2 with 3, 2 and 3 hits):

| Fixture | A | A-prime | C |
|---|---|---|---|
| F1 | about 27 | about 28 | about 23 |
| F2 | about 24 | about 29 | about 22 |
| F3 | about 18 | about 15 | about 14 |
| F6 (one search, 5 hits) | about 14 | about 14 | about 13 |

A-prime's cost is the extra indent level: every hit title sits 16-20 px deeper, so more of them wrap (C: roughly 15-18% fewer lines than A and A-prime on F1).

### 2.4 Where each side is right (no splitting the difference)

| Claim | Verdict |
|---|---|
| Owner: origin must be unmistakable and grouped | Unmistakable: yes, C does it in every row. Grouped: the headline already groups by origin (segments); the list groups by time, which is what a log is. |
| Owner: provider at the end of the group | Kept: at the end of its own search row and its own headline segment. |
| PM: groups break on web-project-web | True for A; **overstated for A-prime**. |
| PM: reorder or appear late while streaming | True for A; **overstated for A-prime** (it only appends). |
| PM: needs an "Other" group | True for A; A-prime avoids it but gets the two-grammar problem on F3. |
| PM: costs most | True for A (rewrites a 1,732-line test file and the announcer); moderately true for A-prime. Not a reason I rely on. |
| PM: flat list keeps the story | True, but weaker than stated: calls inside one model step run in parallel, so their relative order carries no story (J, unverified; the run has steps, nothing in the UI uses them). |
| Researcher: nest reads under their group | Right about the goal (a read belongs to the search that found the page). C reaches it with the merge, which also fixes "5 vs 3". |
| Neither input saw it | The list is open while streaming for every user, and the headline above an open list already says per-origin what a section header would repeat. |

---

## 3. Wireframes

Legend: `[g]` globe (Web), `[f]` folder (Project), `[i]` iFinder document, `[k]` link (connected system), `[d]` file (created), `[s]` skill icon (not sparkles), `[b]` light-bulb, `[*]` spinner (static clock with reduced motion), `[!]` error, `v` and `^` chevrons, `[...]` chip. Frames labelled 320 are about 42 characters wide.

### 3.1 Collapsed line (finished)

EN, desktop, F1 (project search returned nothing):

```
 [b] Thinking process  v
 [s] Skill: Contract review . started manually
 [g] Web  5 results . 3 opened . via Brave Search     [f] Project  no results      v
 iFinder 6 is the newest generation of enterprise search software ...
```

DE, 320 (segments wrap at segment boundaries; chevron stays at the top right of the first line):

```
+--------------------------------------+
| [b] Denkprozess                      |
| [s] Skill: Vertragsprüfung .       v |
|     manuell gestartet                |
| [g] Web  5 Ergebnisse . 3 geöffnet . |
|     über Brave Search                |
| [f] Projekt  keine Ergebnisse        |
| iFinder 6 ist die neueste Generation |
+--------------------------------------+
```

Segment grammar (the owner's wish: origin first, provider at the end of its own origin; strings in section 5):

```
[icon] Noun   results . searches (only if 2+) . opened . failed . via Provider
```
- Noun in medium weight, facts in the secondary colour; facts are separated by a middle dot, segments by space only (no dot between segments: one separator, one meaning).
- Order of segments: skills first (D1), then the origins by first use. Outputs (Created PDF) after the origin segments, always shown.
- At most two origin segments are named, the rest as `+N` (same rule as the footer chip, `MAX_NAMED_KINDS = 2`, `answerBasisModel.js:66`). The `+N` carries visually hidden text naming what it hides, so the button's accessible name still lists everything and still contains the visible text (WCAG 2.5.3). **Known limit:** a sighted reader does not see the names that the `+N` hides; they are in the accessible name and in the expanded list. With three or more origins the collapsed line is therefore not the full "what was used" check, and the expanded list is. Because the finished headline wraps instead of truncating, it could name more than two origins; whether to raise the limit (for example to four) is open question V12 in section 8.
- Connected systems: `[k] Jira  2 calls`, noun = the system label from the server; no "via".
- Rows without origin (older chats): one neutral segment, `2 searches . 5 results`, no icon, nothing guessed.
- Counts belong to their segment only. No global "2 searches".

F3 collapsed, EN desktop: `[i] iFinder  8 results     [k] Jira  2 calls     +1     [d] Created PDF     v`.

### 3.2 Expanded list

EN, desktop, finished, pinned open, Technical details off. F1, MVP:

```
 [g] Web  5 results . 3 opened . via Brave Search     [f] Project  no results        ^
   ( ) Technical details
   |
   |  [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
   |        iFinder: Enterprise AI Search You Can Trust   intrafind.com
   |        Discover the advantages of the latest iFinder generation | IntraFind   intrafind.com
   |        iFinder: the Most Important Features | IntraFind   intrafind.com
   |        iFinder: Enterprise Search made easy | IntraFind   live.intrafind.com
   |        Web Components: iFinder Search in Your Own Interface | IntraFind   intrafind.com
   |  [f] Searched the project for [iFinder6] . no results
   |  [g] Opened web page  iFinder: Enterprise AI Search You Can Trust  intrafind.com . partly read
   |  [g] Opened web page  iFinder: the Most Important Features  intrafind.com
   |  [g] Opened web page  Web Components: iFinder Search ...  intrafind.com
```

After the later merge (a page is shown once):

```
   |  [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
   |        iFinder: Enterprise AI Search You Can Trust   intrafind.com   Opened . partly read
   |        Discover the advantages of the latest iFinder generation ...   intrafind.com
   |        iFinder: the Most Important Features | IntraFind   intrafind.com   Opened
   |        iFinder: Enterprise Search made easy | IntraFind   live.intrafind.com
   |        Web Components: iFinder Search in Your Own Interface ...   intrafind.com   Opened
   |  [f] Searched the project for [iFinder6] . no results
```

DE, 320, same run, MVP (the switch is on its own line; chips wrap to their own line; hit titles clamp to two lines):

```
+----------------------------------------+
| [g] Web  5 Ergebnisse . 3 geöffnet . ^ |
|     über Brave Search                  |
| [f] Projekt  keine Ergebnisse          |
|   ( ) Technische Details               |
|  |                                     |
|  | [g] Im Web gesucht nach             |
|  |     [IntraFind iFinder6]            |
|  |     5 Ergebnisse . über Brave Search|
|  |       iFinder: Enterprise AI Search |
|  |       You Can Trust   intrafind.com |
|  |       Discover the advantages of    |
|  |       the latest iFinder ...        |
|  |       (3 weitere Treffer)           |
|  | [f] Im Projekt gesucht nach         |
|  |     [iFinder6] . keine Ergebnisse   |
|  | [g] Webseite geöffnet               |
|  |     iFinder: Enterprise AI Search   |
|  |     You Can Trust  intrafind.com .  |
|  |     teilweise gelesen               |
+----------------------------------------+
```

Notes: the headline is the same button as when collapsed (chevron `^`); the switch exists only when the turn is finished and a row has technical details; the hit list is shown in full in the real UI ("(3 weitere Treffer)" is only the wireframe's abbreviation).

### 3.3 Streaming states (F4: web, then a second origin joins; list open, answer streams below)

EN, desktop. Nothing above the newest row moves; rows only append or change their text.

```
t=0.0 s   [*] Waiting for the model...  0:02                       (idle line, no list yet)

t=1.4 s   [*] Searching the web for "iFinder6 features"        ^
            [*] Searching the web for [iFinder6 features]

t=2.9 s   [*] Web  5 results . via Brave Search                ^   (between: summary so far + spinner)
            [g] Searched the web for [iFinder6 features] . 5 results . via Brave Search
                  hit x5

t=3.1 s   [*] Searching the project for "iFinder6"             ^
            [g] Searched the web for [iFinder6 features] . 5 results . via Brave Search
                  hit x5
            [*] Searching the project for [iFinder6]               <- appended

t=4.0 s   [*] Web  5 results . via Brave Search   Project  no results     ^   (between)
            [g] ... (unchanged)
            [f] Searched the project for [iFinder6] . no results   <- text changed in place

t=4.2 s   answer text starts streaming below the list; the list stays open, nothing above it moves

finish    list closes by itself; headline: [g] Web 5 results . via Brave Search  [f] Project no results  v
          (if focus was inside the list it moves to the headline button)
```

Origin unknown (older server or unclassified tool): `[*] Searching...` and `[*] Searching for [q]`; no origin word, no icon guess; the text does not change later because the origin never arrives.

DE, 320, the same frame at t=3.1 s:

```
+----------------------------------------+
| [*] Durchsucht das Projekt nach        |
|     „iFinder6“                       ^ |
|  |                                     |
|  | [g] Im Web gesucht nach             |
|  |     [iFinder6 features]             |
|  |     5 Ergebnisse . über Brave Search|
|  |       (5 Treffer)                   |
|  | [*] Durchsucht das Projekt nach     |
|  |     [iFinder6]                      |
+----------------------------------------+
```

The streaming headline may take two lines at 320 px (it wraps; the list below moves by at most one line when it changes length). Accepted and flagged in section 8.

### 3.4 Skill display (revised 2026-11-13: in the activity block, no header chip)

Collapsed, finished, EN desktop. One segment per skill (up to two), first in the line:

```
 [b] Thinking process  v
 [s] Skill: Contract review . started manually     [s] Skill: Brand voice . set by the app
 [g] Web  5 results . 3 opened . via Brave Search     [f] Project  no results           v
```

Three or more skills: one segment, names only; the reasons are in the expanded rows:

```
 [s] Skills: Contract review, Brand voice, Summaries     [g] Web  5 results . via Brave Search     v
```

Expanded. The first three skills are in force from the start, so they are the first rows; the model-chosen skill sits where it happened:

```
   |  [s] Skill: Contract review . started manually
   |  [s] Skill: Brand voice . set by the app
   |  [s] Skill: Legal tone . kept from an earlier message
   |  [f] Searched the project for [iFinder6] . no results
   |  [s] Skill: Summaries . chosen by the model
   |  [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
```

A skill and no search or tool call: the activity block still exists.

```
   collapsed:  [s] Skill: Contract review . started manually           v
   expanded:   |  [s] Skill: Contract review . started manually
```

DE, 320, collapsed with two skills (the headline wraps at segment boundaries; the one disclosure is the headline button):

```
+----------------------------------------+
| [b] Denkprozess                      v |
| [s] Skill: Vertragsprüfung .         v |
|     manuell gestartet                  |
| [s] Skill: Markenstimme .              |
|     von der App festgelegt             |
+----------------------------------------+
```

A skill row has no second rendering: no header chip and no "N skills" count in the headline (the old count of skills is replaced by the segment). In a shared chat the same text is correct because it names no person.

### 3.5 Technical details off and on

EN, desktop, one search row and one read row, finished, list open.

Off (default):
```
   (  ) Technical details
   |  [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
   |        hit x5
   |  [g] Opened web page  iFinder: Enterprise AI Search You Can Trust  intrafind.com . partly read
```
On:
```
   ( * ) Technical details
   |  [g] Searched the web for [IntraFind iFinder6] . 5 results . via Brave Search
   |        Tool  websearch . 1.2 s
   |        extractContent  true     maxResults  5     contentMaxLength  3000
   |        hit x5
   |  [g] Opened web page  iFinder: Enterprise AI Search You Can Trust  intrafind.com . partly read
   |        Tool  read_url . 0.8 s . 1,334 words
   |        maxLength  10000     offset  0
```
DE, 320, On:
```
+----------------------------------------+
|   ( * ) Technische Details             |
|  | [g] Im Web gesucht nach             |
|  |     [IntraFind iFinder6]            |
|  |     5 Ergebnisse . über Brave Search|
|  |       Tool  websearch . 1,2 s       |
|  |       extractContent  true          |
|  |       maxResults  5                 |
|  |       contentMaxLength  3000        |
+----------------------------------------+
```
Argument names stay as the model sent them (they are identifiers, not language); the labels "Tool", "Dauer" and the units are translated.

### 3.6 Sources panel with origin

EN, desktop side panel (about 384 px), mixed web and project, no filter yet (MVP):

```
+----------------------------------------------+
| Sources                                    X |
| (search) iFinder6   (search) iFinder6 features
| Web 5 . Project 3                            |   <- plain text summary, two or more origins
|                                              |
| CITED IN THIS ANSWER (2)                     |
| +------------------------------------------+ |
| | (1) [fav] Web . intrafind.com . 12 Nov   | |
| | iFinder: Enterprise AI Search You Can ...| |
| | "iFinder 6 is the newest generation ..." | |
| +------------------------------------------+ |
| | (2) [file] Project . Project Alpha       | |
| | Contract template v3.docx                | |
| | Uploaded                                 | |
| +------------------------------------------+ |
| READ FOR THIS ANSWER (3)                     |
| | [file] iFinder . [Contracts]   (scope chip) |
| | Framework agreement 2024.pdf             | |
| ALSO CONSIDERED (3)  ...                     |
+----------------------------------------------+
```

Next (origin filter replaces the summary line; outlined = clickable; the profile pills appear only under iFinder):

```
 [All 8] [Web 5] [Project 3]          <- pills, aria-pressed, 24 px high
 (when iFinder is chosen:  [All] [Contracts 4] [HR policies 2])
```

DE, 320 (bottom sheet, `max-h-[80vh]`, same card text):

```
+----------------------------------------+
| Quellen                              X |
| Web 5 . Projekt 3                      |
|                                        |
| IN DIESER ANTWORT ZITIERT (2)          |
| +------------------------------------+ |
| | (1) [fav] Web . intrafind.com .    | |
| |     12. Nov. 2026                  | |
| | iFinder: Enterprise AI Search You  | |
| | Can Trust                          | |
| +------------------------------------+ |
| | (2) [file] Projekt . Project Alpha | |
| | Vertragsvorlage v3.docx            | |
| | Hochgeladen                        | |
| +------------------------------------+ |
+----------------------------------------+
```

Card meta line order: `[n badge] [SourceIcon] Origin noun . identity (site, project name) . date [scope chip]`. The noun is plain text; the glyph in front of it is not drawn in the MVP.

---

## 4. State matrix

### 4.1 Row states (search and read rows, origin known)

| State | Row text (EN example) | Lead icon | Text treatment | Screen reader | Notes |
|---|---|---|---|---|---|
| preparing (arguments being written) | "Preparing <name>..." (unchanged, generic) | spinner or clock | grey | `RunAnnouncer`: "Preparing <name>" | Search and read arguments are tiny, so this rarely paints (`PREPARING_GRACE_MS`, 500 ms, `activityConstants.js:14`). No origin word here: not worth five extra strings. |
| ready (arguments done, waits its turn) | unchanged | clock, static | grey | unchanged | |
| running | "Searching the web for [q]" / "Opening intrafind.com" | spinner (static clock with reduced motion) | label in active weight | `activeLabel` once at start: "Searching the web for q" | The row uses the present phrase; today it says "Searched for" while it spins. |
| awaiting approval | "Waiting for approval" | shield, amber | amber | "Waiting for approval", priority high (unchanged) | |
| completed with results | "Searched the web for [q] . 5 results . via Brave Search" | origin icon | grey | read with the row | |
| completed, declared zero | "Searched the project for [q] . no results" | origin icon | **neutral grey**, not amber, not red: an empty result is information | `RunAnnouncer`: "The project search returned no results" (new, normal priority) | |
| completed, count unknown | phrase, no count, no "no results" | origin icon | grey | read with the row | older servers, provider-run search, passages that are not attached |
| failed | "Searched the web for [q] . Failed" + reason line | red exclamation | red, with words | `RunAnnouncer`: existing failed announcement | never "no results" |
| stopped by the user | "... . Stopped" | clock or origin icon | grey | existing | |
| read, partly | "Opened web page <title> host . partly read" | origin icon | neutral | read with the row | words and depth in Technical details |
| read, no text | "Web page returned no text <title> host" (not "Opened") | origin icon | neutral | read with the row | a completed fetch that delivered no text, for example `read_url` with `offset` at or past the end; not counted in "N opened"; needs the declared read outcome (G10) |
| read, limit reached | "Not opened <title>" + the existing page-read-limit sentence | origin icon | amber, sentence visible | read with the row | existing behaviour, wording changed |
| read failed | "Opened web page ... . Failed" + the existing reason line | red exclamation | red, with words | `RunAnnouncer`: existing failed announcement | the fetch row's own Failed state; the hit-level "Not readable" is removed with the hit-level marker |
| hit | title link, host | none | link | link name = title | no read marker in the MVP |

### 4.2 Headline states

| Mode | When | EN | DE | Notes |
|---|---|---|---|---|
| idle | the model is silent | "Waiting for the model..." / "Thinking..." + clock | "Wartet auf das Modell..." / "Denkt nach..." + clock | unchanged, no origin |
| preparing | a call's arguments are being written | "Preparing <name>..." | "<name> wird vorbereitet..." | unchanged |
| running | a call runs | origin phrase with query (section 5.1) | same | newest running row owns the line |
| awaiting | approval pending | "Waiting for approval" | "Wartet auf Freigabe" (existing string) | |
| between | turn goes on, nothing active | segments so far + spinner | same | may take two lines at 320 px |
| summary (streaming answer) | text streams | segments, no spinner | same | |
| summary (finished) | turn over | segments, wraps | same | `+N` beyond two origins |
| finished, with failures | some call failed | `Web  5 results . 1 failed` (red "1 failed") | `Web  5 Ergebnisse . 1 fehlgeschlagen` | status tint, text carries it |
| finished, only creators | only a PDF | "Created PDF" (unchanged) | "PDF erstellt" | no origin segment |
| finished, no origin | old chats | `2 searches . 5 results`, no icon | `2 Suchen . 5 Ergebnisse` | nothing guessed |

### 4.3 Skill row and segment states

| State | Text | Notes |
|---|---|---|
| user | "Skill: X . started manually" | |
| model | "Skill: X . chosen by the model" | |
| app | "Skill: X . set by the app" | needs the new `app` value |
| chat | "Skill: X . kept from an earlier message" | needs a frame for carried skills |
| unknown | "Skill: X" | old stored chats |
| two routes for one skill | the earliest and most explicit: user over app over model | |

---

## 5. Copy table (EN and DE)

German is formal or impersonal (Sie where a pronoun is unavoidable; none is needed below). Quotes are locale-specific and live in the string: EN “...”, DE „...“. Plurals use `_one` / `_other` keys as the file already does. All DE strings need native review.

### 5.1 Per-origin phrases (whole phrases; the query chip follows the "row" phrases)

| Role | Key (proposed) | web | project | ifinder | iassistant | documents |
|---|---|---|---|---|---|---|
| EN headline, running, with query | `toolActivity.origin.<origin>.searchingFor` | Searching the web for “{{query}}” | Searching the project for “{{query}}” | Searching iFinder for “{{query}}” | Searching iAssistant for “{{query}}” | Searching document sources for “{{query}}” |
| EN headline, running, no query | `toolActivity.origin.<origin>.searching` | Searching the web… | Searching the project… | Searching iFinder… | Searching iAssistant… | Searching document sources… |
| EN row, running (query chip follows) | `toolActivity.origin.<origin>.rowSearching` | Searching the web for | Searching the project for | Searching iFinder for | Searching iAssistant for | Searching document sources for |
| EN row, done (query chip follows) | `toolActivity.origin.<origin>.rowSearched` | Searched the web for | Searched the project for | Searched iFinder for | Searched iAssistant for | Searched document sources for |
| DE headline, running, with query | same keys | Durchsucht das Web nach „{{query}}“ | Durchsucht das Projekt nach „{{query}}“ | Durchsucht iFinder nach „{{query}}“ | Durchsucht iAssistant nach „{{query}}“ | Durchsucht Dokumentquellen nach „{{query}}“ |
| DE headline, running, no query | same keys | Durchsucht das Web… | Durchsucht das Projekt… | Durchsucht iFinder… | Durchsucht iAssistant… | Durchsucht Dokumentquellen… |
| DE row, running | same keys | Durchsucht das Web nach | Durchsucht das Projekt nach | Durchsucht iFinder nach | Durchsucht iAssistant nach | Durchsucht Dokumentquellen nach |
| DE row, done | same keys | Im Web gesucht nach | Im Projekt gesucht nach | In iFinder gesucht nach | In iAssistant gesucht nach | In Dokumentquellen gesucht nach |

Key layout: the new phrases live under `toolActivity.origin.<web|project|ifinder|iassistant|documents>.<role>` because `toolActivity.searching`, `searchingFor` and `searchedFor` already exist as plain strings and a key cannot be both a string and an object in the locale files.

Origin unknown (generic, existing strings kept for the no-origin case): `toolActivity.searchedFor` "Searched for" / "Gesucht nach"; `toolActivity.searchingFor` "Searching for “{{query}}”" / "Sucht nach „{{query}}“"; new `toolActivity.searchingGeneric` "Searching…" / "Sucht…". The existing `toolActivity.searching` ("Searching the web…") must stop being the fallback: it guesses web.

Reads (live and done):

| Role | Key | web | project | ifinder | iassistant | documents |
|---|---|---|---|---|---|---|
| EN headline, running (host or title) | `toolActivity.origin.<origin>.opening` | Opening {{host}} | Opening “{{title}}” | Opening “{{title}}” | Opening “{{title}}” | Opening “{{title}}” |
| EN row, running | `toolActivity.origin.<origin>.rowOpening` | Opening web page | Opening document in the project | Opening document in iFinder | Opening document in iAssistant | Opening document |
| EN row, done | `toolActivity.origin.<origin>.rowOpened` | Opened web page | Opened document in the project | Opened document in iFinder | Opened document in iAssistant | Opened document |
| DE headline, running | same keys | Öffnet {{host}} | Öffnet „{{title}}“ | Öffnet „{{title}}“ | Öffnet „{{title}}“ | Öffnet „{{title}}“ |
| DE row, running | same keys | Öffnet Webseite | Öffnet Dokument im Projekt | Öffnet Dokument in iFinder | Öffnet Dokument in iAssistant | Öffnet Dokument |
| DE row, done | same keys | Webseite geöffnet | Dokument im Projekt geöffnet | Dokument in iFinder geöffnet | Dokument in iAssistant geöffnet | Dokument geöffnet |
| EN row, done, no text | `toolActivity.origin.<origin>.rowOpenedEmpty` | Web page returned no text | Document in the project returned no text | Document in iFinder returned no text | Document in iAssistant returned no text | Document returned no text |
| DE row, done, no text | same keys | Webseite lieferte keinen Text | Dokument im Projekt lieferte keinen Text | Dokument in iFinder lieferte keinen Text | Dokument in iAssistant lieferte keinen Text | Dokument lieferte keinen Text |

When a page has no host yet or a document no title: `toolActivity.openingGeneric` "Opening…" / "Öffnet…".

A read that completed but delivered no text (G10, for example `read_url` with `offset` at or past the end of the page) uses `rowOpenedEmpty`, never `rowOpened`, so the row and the "N opened" count agree.

Segment nouns (headline): reuse `chatMessage.answerBasis.kind.web|project|ifinder|iassistant` (EN Web, Project, iFinder, iAssistant; DE Web, Projekt, iFinder, iAssistant). For `documents` use new `toolActivity.originDocuments`: "Document sources" / "Dokumentquellen" (see O-1). For `integration` the noun is the server's label (Jira, Munich AD).

### 5.2 Facts, markers, status

| Key | EN | DE | Note |
|---|---|---|---|
| `toolActivity.results_one/_other` (existing) | {{count}} result / results | {{count}} Ergebnis / Ergebnisse | unchanged |
| `toolActivity.noResults` | no results | keine Ergebnisse | declared zero only |
| `toolActivity.via` | via {{name}} | über {{name}} | visible text; replaces the `title` "Data from" / "Daten aus" |
| `toolActivity.searches_one/_other` (existing) | {{count}} search / searches | {{count}} Suche / Suchen | shown only when 2 or more |
| `toolActivity.openedCount_one/_other` | {{count}} opened | {{count}} geöffnet | no noun, so no "pages" / "Seiten"; counts completed fetches only (D2) |
| `toolActivity.failedCount_one/_other` | {{count}} failed | {{count}} fehlgeschlagen | red text |
| `toolActivity.calls_one/_other` | {{count}} call / calls | {{count}} Aufruf / Aufrufe | connected systems; replaces "tool call" in segments |
| `toolActivity.partlyRead` | partly read | teilweise gelesen | neutral; replaces "truncated" / "gekürzt" |
| `toolActivity.hitOpened` (Later, with the merge) | Opened | Geöffnet | marker on a hit whose page was opened; neutral, not green |
| `toolActivity.hitExcerpt` (only if the label test asks for it) | Excerpt | Auszug | D2 fallback |
| `toolActivity.notOpened` | Not opened | Nicht geöffnet | replaces `notRead` |
| `toolActivity.failed` / `stopped` (existing) | Failed / Stopped | Fehlgeschlagen / Abgebrochen | unchanged |
| `chatMessage.answerBasis.more` (existing) | +{{count}} | +{{count}} | the `+N` of the headline |

### 5.3 Skill

| Key | EN | DE |
|---|---|---|
| `toolActivity.skillLabel` (new; or `chatMessage.skill.label`) | Skill: {{name}} | Skill: {{name}} |
| `toolActivity.skillByUser` (value changes) | started manually | manuell gestartet |
| `toolActivity.skillByModel` (value changes) | chosen by the model | vom Modell ausgewählt |
| `toolActivity.skillByApp` (new) | set by the app | von der App festgelegt |
| `toolActivity.skillByChat` (new) | kept from an earlier message | aus früherer Nachricht übernommen |
| `toolActivity.skillsLabel` (new, the collapsed segment for three or more skills) | Skills: {{names}} | Skills: {{names}} |

### 5.4 Disclosures

| Key | EN | DE | Note |
|---|---|---|---|
| `pages.appChat.thinkingProcess` (new; replaces `showThoughts` / `hideThoughts`) | Thinking process | Denkprozess | same word as the settings checkbox "Show thinking process" / "Denkprozess anzeigen" |
| `toolActivity.technicalDetails` | Technical details | Technische Details | |
| `toolActivity.technicalDetailsHint` | Shows each step's tool, arguments and duration. | Zeigt für jeden Schritt Tool, Argumente und Dauer. | `aria-describedby` |
| `toolActivity.detailTool` | Tool | Tool | in Technical details |
| `toolActivity.detailDuration` | Duration | Dauer | |

### 5.5 Sources panel

| Key | EN | DE |
|---|---|---|
| `sources.originSummary` (label of the summary list) | Sources by origin | Quellen nach Herkunft |
| `sources.originFilter` (Next, fieldset legend) | Filter by origin | Nach Herkunft filtern |
| card noun | reuses `chatMessage.answerBasis.kind.*` and `toolActivity.originDocuments` | same |

### 5.6 Screen-reader only

| Key | EN | DE |
|---|---|---|
| `toolActivity.announce.noResults.web` | The web search returned no results | Die Websuche hat keine Ergebnisse geliefert |
| `...noResults.project` | The project search returned no results | Die Suche im Projekt hat keine Ergebnisse geliefert |
| `...noResults.ifinder` | The iFinder search returned no results | Die Suche in iFinder hat keine Ergebnisse geliefert |
| `...noResults.iassistant` | The iAssistant search returned no results | Die Suche in iAssistant hat keine Ergebnisse geliefert |
| `...noResults.documents` | The document sources returned no results | Die Suche in Dokumentquellen hat keine Ergebnisse geliefert |

### 5.7 Keys to retire (verify each is unused, including `tests/` and e2e, before deleting; EN and DE together; the key-parity test must stay green)

`toolActivity.usedSkill`, `skills_one/_other`, `searchedWeb`, `searchedDocuments`, `readWeb`, `readDocuments`, `pagesRead_*`, `documentsRead_*`, `read`, `readTitle`, `readDocumentTitle`, `readFailedTitle`, `integrationTitle`, `truncated`, `truncatedTitle`, `notRead`, `readFailed`, `searchingDocuments`, `readingDocuments`, `readingDocument`, `reading`, `readPage`, `toolCalls_*` if no longer used by a segment; `pages.appChat.showThoughts` and `hideThoughts` (the thoughts link; the other `showThoughts` keys at `en.json:6907`/`de.json:668` are the settings checkbox and stay). `toolActivity.wordsRead_*` stays (Technical details).

### 5.8 German register: the existing outliers

Count: about 986 `de.json` values with Sie/Ihr-forms against 22 with du-forms (my regex over the values; one false positive, `admin.updates.updatesFolder`, is `{{dir}}`). The PM's "informal du already used" premise is wrong.

In scope (fix with this change):

| Key | Value today | Replace with |
|---|---|---|
| `toolActivity.skillByUser` | von dir gestartet | manuell gestartet (D1) |
| `sources.documentNoAccess` | ...: Du hast keinen Zugriff darauf. | ...: Sie haben keinen Zugriff darauf. |
| `sources.documentUnavailable` | ...: ... steht dir nicht zur Verfügung. | ...: ... steht Ihnen nicht zur Verfügung. |

Out of scope, separate ticket (list so nobody rediscovers them): `chatMessage.user` ("Du": the label on every user message, the most visible one), `pages.appChat.messagePlaceholder`, `confirmClear`, `noMessagesSubtitle`; `pages.appsList.pendingDocument.unavailable`, `noAccess`, `continueWithout`; `pages.appsList.nextcloudSelection.description`; `feedback.commentPlaceholder`, `feedback.thankYou`; `admin.chat.placeholder`; `admin.nextcloudEmbed.embedUrlDesc`, `noOrigins`, `step2`; `admin.integrations.actionDetail.effectHelp`, `intro`, `effectLead`, `instructions.sourceAdmin`; `responseStyles.descriptions.explanatory` (an instruction to the model, probably not UI copy). The admin strings may be informal on purpose; ask.

Research's German concerns, answered: "Gelesen" as a state is gone (rows say "geöffnet"; "teilweise gelesen" uses "gelesen" as a quantity, not a state, and is on the label test); "Seiten" is gone (rows say "Webseite", counts say "geöffnet" with no noun); "Denkanalyse" is replaced by "Denkprozess" (D4).

---

## 6. Accessibility spec

Target: WCAG 2.2 AA, 320 CSS px reflow, dark mode, reduced motion, screen readers, touch. Nothing here relies on a `title`.

### 6.1 Roles, names, structure

| Element | Markup | Accessible name and state |
|---|---|---|
| Skill rows | `<li>` in the activity `<ol>`, plain text, not focusable, no `title` | "Skill: Contract review, started manually" (visually hidden comma after the name so it is read as two phrases). The headline button's name also contains the skill segment, so it is heard without expanding. |
| Thinking process | `<button aria-expanded aria-controls>` + region `id` | "Thinking process, collapsed/expanded"; icon `aria-hidden`; same classes as the activity button (D4) |
| Activity headline | existing `<button aria-expanded aria-controls>` | Name = its visible text, nothing else (no `aria-label`, so WCAG 2.5.3 holds). Segments are separated by a visually hidden full stop; a noun is followed by a visually hidden colon; `+N` carries visually hidden text naming what it hides. Example name: "Web: 5 results, 3 opened, via Brave Search. Project: no results." |
| Technical details | `<button role="switch" aria-checked aria-describedby>` | "Technical details, switch, on/off"; hint from section 5.4 |
| List | `<ol aria-busy>` (existing), `aria-live="off"` stays on the block | rows are `<li>`; each row's text starts with its origin phrase, so a row is understood on its own |
| Hits | nested `<ul>` (existing) | link name = title; host as text after it |
| Sources panel | `role="dialog"` + `aria-labelledby` (existing); `h2` Sources; `h3` section titles (existing) | summary line is a `<ul aria-label="Sources by origin">` of "Web, 5" items; Next: `<fieldset>` + `<legend>` and `aria-pressed` buttons (existing pattern of `ScopeFilter`) |

No headings inside a message: they would pollute the page's heading outline. Origin is understood from text in every row, so there is nothing to navigate by.

### 6.2 Reading order and keyboard order (same as the visual order)

1. Thinking process button, then its text when open
2. Activity headline button (its name includes the skill segment)
3. Technical details switch (only when finished and open)
4. Rows in time order, with the skills in force from the start first; the tab stops inside are the hit links and page links (a skill row has none)
5. Message text
6. Footer chip, results tile

Keys: Enter and Space on the two disclosure buttons and on the switch; Tab and Shift+Tab through links; no custom shortcuts; no focus trap (the sources panel keeps its existing trap on narrow screens).

### 6.3 Announcements (`RunAnnouncer`, polite, one at a time; the list stays `aria-live="off"`)

| Moment | Said | Source |
|---|---|---|
| a call starts | the active label with its origin, no ellipsis, no numbers: "Searching the web for iFinder6" | existing `activeLabel` via `spoken()` (`deriveAnnouncements.js:101-115`); the origin comes from the new phrases |
| a search ends with a declared zero count | "The project search returned no results" | new, priority normal, once per call (`<callId>:empty`) |
| a call fails, is stopped, awaits approval | existing texts | unchanged |
| a skill is activated | nothing (the skill row is static text; skill rows are already skipped, `deriveAnnouncements.js:172`); the headline's accessible name carries the skill segment | unchanged |
| the turn ends | nothing new (the footer chip's label already names the basis) | decision D7; validate with a screen-reader user |
| the Technical details switch changes | the switch's own state change | native, no announcer text |

Never announced: clocks, byte counts, hit counts as they tick, the reasoning text.

### 6.4 Focus

- Toggling either disclosure or the switch keeps focus on it.
- **New:** when the list closes by itself at the end of a turn and `document.activeElement` is inside it, move focus to the headline button (otherwise it falls back to the document body).
- Focus ring: the existing `focus-visible:ring-2 ring-indigo-500` on every new control. Ring contrast against both themes at least 3:1 (WCAG 1.4.11).

### 6.5 Targets, reflow, motion, colour

- **Target size (WCAG 2.5.8, #3619):** the headline button is `py-1 -my-1` (about 24 px) and stays; the switch is at least 24 px high; hit and page links get `min-h-6` (they are now 16 px lines separated by 2 px, which fails the spacing exception); the origin and profile filter pills get `min-h-6` (`ScopeFilter` pills are about 22 px today).
- **Reflow (1.4.10) at 320 px and text resize to 200%:** the finished headline wraps at segment boundaries, never `truncate`; query chips keep `break-all`; hit titles use a two-line clamp with `break-words`, not `truncate`; the chevron is top-aligned and never alone on a line; no horizontal scroll. A skill row's reason wraps under its name.
- **Text spacing (1.4.12):** no fixed heights on rows or chips.
- **No hover-only content (1.4.13) and nothing only in `title`:** retire the title-only meanings: `IntegrationChip` ("Data from X" becomes visible "via X"), "truncated" tooltip ("partly read" is visible), the read-marker tooltips (the marker is gone), `ToolLabel`'s tool id (moves to Technical details), the headline's duplicate `title`. The hit link's `title={url}` may stay as a duplicate, not as the only source of a fact.
- **Colour (1.4.1, #3619):** status is tinted and always has words (Failed, no results, partly read, Not opened); origin is distinguished by icon and noun, never by colour. No outlined element is non-interactive: the provider is no longer an outlined chip (it looked clickable, `ToolActivity.jsx:467-478`), the skill row is not outlined. Text contrast at least 4.5:1 in light and dark for grey secondary text on the page background (UI designer to verify the tokens).
- **Reduced motion:** spinners become the static clock (existing `BusyIcon` behaviour); the chevron and the switch thumb use `motion-reduce:transition-none`; rows appear without animation; no auto-scrolling.
- **Language (3.1.2):** provider and product names (Brave Search, iFinder) are proper nouns and need no `lang`.

### 6.6 Surfaces

Main chat, shared read-only chat (no "you"; Technical details control absent when no row has details), Outlook task pane at 320 px, extension side panel, phones. The sources panel is a bottom sheet below 768 px (existing).

---

## 7. Data the design needs that the PM contract does not carry

The PM contract (section 4) covers `activityOrigin` on `tool/started`, the `args` frames and the ledger, `integration` as provider, `Source.origin`, `activatedBy: 'app'`, the `read_url` basis fix and persisted `integration`. These are additional or sharper:

| # | Gap | Why the design needs it | Size | When |
|---|---|---|---|---|
| G1 | **A server-declared result count and outcome on each search call** (for example `resultCount: number or null` on `tool/completed` and the ledger; `null` = unknown). | "no results" must be decided by the server. The client cannot tell zero hits from hits that were not attached (provider-run search rows have `sources: []` by construction; knowledge "searched" mode returns passages). The PM's M1 counter has `outcome` but the wire does not. | S | MVP |
| G2 | **Origin on the provider-run (native) web search row** that the client synthesizes from grounding metadata (`nativeSearchRow`, `toolActivity.js:404-422`), and optionally a provider label for it. | Today that row hard-codes `scope: 'web'` and has no `integration`; it would be a segment-less row. | S | MVP (origin), later (label) |
| G3 | **Origin of the `chat_sources_read` recall tool** (re-reading a source an earlier answer found): the origin of the source it recalls. | The seam returns null for it today; the row would show no origin. | S | MVP edge |
| G4 | **`activatedBy: 'chat'`, and a frame for carried skills**, plus the fold precedence user, app, model in `foldSkill`; both whitelists (stored, shared) keep `app` and `chat`. | D1 rule has no hole only if carried skills are announced. `earlierSkillRefs` already holds `by: 'user' or 'model'` (`skillAccess.js:502-521`), so the server knows who first activated it. | S-M | MVP or next, PO call (PM question 7) |
| G5 | **Origin label for the `documents` kind** (the admin-configured source's display name) and later **project name and iFinder profile** on rows. | Segments and rows can say "Handbook" instead of "Document sources"; names must be scrubbed in shares (precedent: `runActivity.js:581-590`). | S-M | Next |
| G6 | **Per-source read depth** (`read.depth: excerpt or full`) on the web producer. | Needed only for the "Excerpt" marker (fallback in D2) and for showing extract depth in Technical details. Today `extractedContent` gives `read: { ok }` and a fetched page gives `read: { ok, words, truncated }`; telling them apart by the presence of `words` would be a client inference. | S | Later |
| G7 | **Scope provenance at run start** (`webSearch` or an attached project enabled by `user` or by `app`). | D6: the only truthful "who" for searches. A sentence in the footer popover, not on rows. Not on any run event today (`RequestBuilder.js:725`). | M | Later |
| G8 | **Model step number per call** (which calls ran in the same step). | Would let the list show that two calls were parallel and drop the implied order claim. Hypothesis, not needed for MVP. | S | Later, only if validation asks |
| G9 | **`read` of a hit by id match across calls** (already true: sources share an id across calls, `countRead` relies on it). | Needed for the later merge; verify that the id of a hit and of the page fetched later are equal for web results (it is arithmetically implied by "5 read, 3 rows" in the screenshot, not directly observed). | none | verify before the merge |
| G10 | **A declared outcome for a page or document read that delivered no text** (for example opened, empty, failed). | "N opened" counts fetch rows that completed, did not hit the read limit and did not report `read.ok === false`. A `read_url` call with `offset` at or past the end of the page completes with empty `content` and `read.ok: true`, so that rule alone would count it as opened. Fixture: offset at the end of a page. | S | MVP |

Client-computed, so no data needed: opened count per origin (from `fetch` rows that completed, did not hit the read limit, did not report `read.ok === false` and delivered text, see G10), searches per origin, "N failed", `+N`, the origin summary on the sources panel (from `Source.origin`).

---

## 8. What to validate with real people

All of this is a plan, not evidence. Reuse the research script (`01-research.md` section 7): fixtures replayed through `buildToolActivity`, two builds behind a flag, German sessions, at least two Outlook-pane participants, one screen-reader session. Added or changed items for this brief:

| # | Question | Stimulus | Rule that decides |
|---|---|---|---|
| V1 | **Structure (D0).** Flat origin-worded list versus A-prime sections. | F1 and F2, expanded; task "Which origin did the three page openings come from?" and "In what order did it look?" | Fewer than 5 of 6 say "web" for the three openings with the flat list, or any compliance participant is confidently wrong: switch the expanded list to A-prime (renderer-only). Otherwise keep C. |
| V2 | "Opened" vs "geöffnet" vs "abgerufen"; "partly read" vs "teilweise gelesen"; does removing the hit marker leave a gap ("did it read the other two?"); does "3 opened" versus the panel's "Read (5)" confuse? | label test plus F1 | If many ask about the other two hits, add the "Excerpt" marker (D2 fallback). |
| V3 | Skill row and segment: "started manually / manuell gestartet" vs "started by you / von Ihnen gestartet"; does the row on every answer of an app-set skill annoy; does "kept from an earlier message" make sense; with three or more skills, does the collapsed line hide the reasons too much; do people see that the first rows were in force from the start. | F-skill (all four routes) | If "manuell" is misread, use "you" in own chats and "by the user" in shares. |
| V4 | "Thinking process / Denkprozess" vs "Reasoning / Gedankengang"; do the two lines read as a family; order. | label test and screenshot | Pick the winner of the label test; if the PM refuses restyle, check the label-only version. |
| V5 | "no results / keine Ergebnisse" vs "no matches / keine Treffer"; "Web" vs "Internet"; "Dokumentquellen" comprehension; "the project" when two projects are attached. | label test | |
| V6 | "via Brave Search": does "via" read as the recipient of the query (the egress reading, P2) or as the source? | compliance participants | If read as a source only, try "sent to / gesendet an". |
| V7 | Technical details: can an admin find the arguments in under 30 seconds; do non-admins ever turn it on; does the preference surprise anyone when it applies to every message; switch announced correctly by NVDA, JAWS and VoiceOver. | task for admins; SR session | |
| V8 | Streaming (F4): record a session at 320 px and at desktop; count visible jumps of the headline and the newest row; does the two-line headline at 320 px bother? | recording, frame review | If the headline jumps, clamp it to one line while streaming only. |
| V9 | Screen reader: the collapsed line's accessible name; the "no results" announcement; steps to answer "was the project used?"; focus after the list closes by itself. | one SR session | At least 50% fewer stops than today (research metric). |
| V10 | Sources panel: is the origin noun without a glyph enough; is `Web 5 . Project 3` understood as a count of cards; project versus iFinder document told apart. | panel screenshot | If not, add the origin glyph with the collision fix. |
| V11 | "5 results" in the headline versus "N results" in the footer tile can still differ (research F16). Does anyone notice? | mixed fixture | If yes, rename the segment's word (for example "hits / Treffer"). |
| V12 | Does the collapsed line need to name more than two origins? With three origins (web, project, iFinder) a sighted reader sees two names and `+1`. | mixed fixture with three origins | If compliance participants cannot say from the collapsed line whether iFinder was used, raise the finished headline's limit to four (the footer chip keeps two). |

---

## 9. Handoff: how to continue (for a junior)

Open decisions for the product owner (decide before the build is sliced):
- **O-1.** Footer noun for kind `documents`: change `chatMessage.answerBasis.kind.documents` and `phrase.documents` to "Document sources" / "Dokumentquellen" so footer, headline and rows agree (a one-string change, not a footer redesign). If refused, use "Documents / Dokumente" in segments and rows and accept the false-friend risk for this one kind.
- **O-2.** Carried-over skills in the MVP (G4) or in the next slice.
- **O-3.** Is the small restyle of the reasoning disclosure (D4 steps 1 and 2) in this slice, or label and `aria-expanded` only.
- **O-4.** Chats stored before the change: clean break (PM recommendation; I agree). Old rows show generic phrases and a neutral segment.
- **O-5.** Person-neutral skill wording (D1) versus "you".
- **O-6.** Decided by the product owner on 2026-11-13: the skill lives in the activity block (row plus leading headline segment), not in a header chip (D1). V3 tests it.

Build order (renderer side; the server slice is the PM's MVP-1 plus G1-G4):
1. `client/src/features/chat/activityHeadline.js`: replace the `scope` guess in `searchLabel`, `fetchLabel`, `activeLabel` with origin-keyed phrases; rewrite `finishedHeadline` and `searchedParts` into a segment model (an array, not a string); delete `lookedAtIcon`'s globe default; `countRead` becomes `openedCount` from `fetch` rows. Add a leading skills segment: one per skill up to two, `Skills: A, B, C` for three or more, not counted against the limit of two named origins.
2. `client/src/features/chat/components/ToolActivity.jsx`: segment rendering with wrap and the `+N`; row grammar (`SearchRow`, `FetchRow`); restyle `SkillRow` to the row grammar (no outline, `Skill: <name> · <reason>`, skills in force from the start first), `IntegrationChip` becomes text ("via"), `ItemDetails` behind the switch, hit link wrapping and 24 px targets, focus move on automatic close.
3. `client/src/features/chat/components/ChatMessage.jsx` (about lines 971-1020): the skill chips are removed (skills are rows in `ToolActivity`); the Thinking process button (same classes as the activity button, `aria-expanded`).
4. `client/src/features/chat/deriveAnnouncements.js`: one new announcement per declared-empty search.
5. `client/src/features/chat/components/AnswerSources.jsx`: origin noun on `SourceCard`, the summary line; Next: origin filter beside `ScopeFilter`.
6. `shared/i18n/en.json` and `de.json`: section 5; retire section 5.7 keys; keep EN/DE parity.
7. Tests: the headline assertions in `tests/unit/client/tool-activity.test.jsx` (about seven), `run-announcer.test.jsx`, a switch test, a 320 px layout check, axe (`tests/e2e/accessibility.spec.js`). Add the SPDX header to every new file.
8. Docs and the release note (PM section 12); `docs/accessibility.md` gets the switch pattern.

Do not: infer origin from a tool id or from `scope`; show an actor on a search row; use colour to distinguish origins; write "documents" for a project search; use an outlined element for something that is not clickable; put anything only in a `title`; reorder or remove a row that has been painted; add a compat shim without asking.

Verify first (30 minutes each, PM items V1-V3 stand): reopened chat loses "Brave Search"; a `read_url`-only answer's footer; any UI for carried-over skills (my reading: none, section 0). New for this brief: confirm that a hit and the page fetched later share one source id for web results (G9), and that the screenshot's project search really returned zero hits and not hits that were never attached (research F7).
