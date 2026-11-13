# Activity origin: say where an answer came from

Status: proposal for product-owner review, 2026-11-13. No source code was changed.

**Revision 2026-11-13 (product-owner decision):** the skill lives in the activity block (a row in the list and a leading segment in the collapsed line), not in a header chip. The first version of this proposal recommended the chip; `03-ux-brief.md` D1 holds both the revised rule and the trade-off.

## The request

When the model searches the web, a project, iFinder or any other integration, the chat should say so. The Sources panel should show which system each result came from. In the thought chain, web search and project search sit in one flat timeline, and it is not clear who started a step or where it searched. A skill shows up sometimes as a chip on top and sometimes in the thought chain too. The product owner asked for a solution and a design proposal after consulting a product manager, a UX designer and a UI designer, with user research.

The run that triggered it is in `problem-run.png`.

## How this was produced, and what it can and cannot tell you

Four role reviews, each reading the screenshot, the code and the issue history (#3038, #3521, #3619, plus `concepts/2026-11-12 Answer Footer Basis Chip.md`):

| Document | Role | Content |
|---|---|---|
| `00-fact-base.md` | shared brief | what the screenshot shows, what the code does, the binding prior decisions |
| `01-research.md` | UX researcher | 18 findings, persona walkthroughs, EN/DE vocabulary verdicts, a one-week validation plan |
| `02-product-brief.md` | senior PM | problem framing, options A to D, user stories, scope slices, metrics, open decisions |
| `03-ux-brief.md` | senior UX designer | decision log, fixture comparison, wireframes, state matrix, copy EN/DE, accessibility, data gaps |
| `04-ui-spec.md` | senior UI designer | visual spec, icon collisions, contrast table, implementation map with class strings |
| `mockups.html` | senior UI designer | every state as a static page, light and dark, desktop and 320 px |

Limits:

- **No real users were interviewed.** The persona "interviews" in `01-research.md` are simulated. Every answer there is tagged as a hypothesis. They predict where people will misread the screen. They are not user data. A one-week test with 6 to 8 real participants is planned in `01-research.md` section 7 and `03-ux-brief.md` section 8.
- **The app was not run.** Findings come from reading the code. Three of them need a runtime check first (see "Verify first").
- The mockups were checked in Chromium on Linux only. Tailwind was not installed, so grays, ambers and reds were converted from Tailwind v4 defaults by script.
- German strings have not had a native review.

## What is wrong today

Each point was read in the code.

1. **The server knows more than it sends.** `classifyToolKnowledgeSource` tells web, project, iFinder, configured sources and integrations apart, then `activityScopeOf` (`server/utils/toolDisplay.js`) reduces that to `web` or `documents`. A project search therefore reads "Searched documents", while the footer chip says "Project".
2. **Three vocabularies for one idea:** the activity `scope`, the source `provider` and `kind`, and the footer `answerBasis.kind`.
3. **The collapsed headline adds up unrelated things.** "2 searches" is one web plus one project search. "Brave Search" comes last, so it reads like another count.
4. **A search with no hits is silent.** The result count only renders when `sources.length > 0`, so the project row in the screenshot looks like nothing happened.
5. **The flat, chronological list reads as a hierarchy.** The three web page reads come after the project search, at the same level, so they look like its children.
6. **"Read" means five things**, and the numbers do not reconcile (5 pages read, 3 read rows).
7. **A skill is drawn twice** (header pill and a row). `announcedSkills` in `server/routes/chat/sessionRoutes.js` marks every skill that is not carried over as `activatedBy: 'user'`, so a skill the app switched on reads "started by you". The server knows five routes (composer, typed `/name`, app auto-activate, carried over, model) and the wire carries two.
8. **Raw tool arguments** (`extractContent`, `maxLength`, `offset`, `limit`) are shown to everyone.

## Recommendation

One origin vocabulary, decided by the server and shared by the activity line, the sources panel and the footer chip: the footer's kinds (`project`, `web`, `ifinder`, `iassistant`, `documents`, an integration's own label). Colour never tells origins apart; icon plus noun does.

| Surface | Today | Proposed |
|---|---|---|
| Collapsed line | `Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search` | `Web  5 results · 3 opened · via Brave Search   Project  no results` (one segment per origin) |
| While running | `Searching for “iFinder6”` | `Searching the project for “iFinder6”` |
| Rows | `Searched for` on every origin | origin in the phrase and an origin icon: `Searched the project for [iFinder6] · no results` |
| Sources panel | site and date | origin noun on every card (`Web · intrafind.com`, `Project · Project Alpha`) and a summary `Web 5 · Project 3`; an origin filter next |
| Skills | pill on top plus a row in the list | once, in the activity block: a row `Skill: Contract review · started manually` (also: chosen by the model, set by the app, kept from an earlier message) and a leading segment in the collapsed line; no header chip |
| Raw arguments | on every row | behind a "Technical details" switch, off by default |
| Reasoning link | `Show thinking analysis` | `Thinking process`, same shape as the activity line |
| "Read" | green eye on hits, "Read" rows, "5 pages read" | retired: "Opened web page" rows and "N opened" (counts only fetches that succeeded) |

German strings, whole phrases per origin, are in `03-ux-brief.md` section 5. The German UI is formal ("Sie"; 970 strings against 23 informal). The PM's draft assumed informal "du" and was corrected.

## Where the reviewers disagreed, and the call

**Structure of the expanded list.** This is the one that departs from the product owner's sketch.

- Product owner and researcher: one block per origin ("Search in web", "Search in projects"), hits inside, provider at the end.
- PM: keep the list chronological and flat, put the origin in every row, and move the per-origin totals into the collapsed line.
- UX: the PM is right about a regrouped list (it reorders and misstates the order when web, project, web interleave), but overstated about a variant that only appends headers in run order ("A-prime"). UX still recommends the flat list: the list is open for every user while the answer streams (`open = expanded ?? loading`), so extra header lines are paid by every answer, a header would repeat the segment shown directly above the open list, and an agentic run with Jira, Munich AD and a PDF creator gets one header per one-call system.

The call: **flat list, origin in every row, per-origin segments in the collapsed line** (UX scored it 111 to 95 to 83 over six scenarios; those scores are judgment). The product owner's sketch stays as the fallback, and it is a renderer-only switch because the data is identical. `mockups.html` section 1 shows today, the recommendation and the sketch side by side on the screenshot run.

Other disagreements, resolved by UX:

| Question | Inputs | Call |
|---|---|---|
| Where does a skill live | researcher: one line in the activity, actor only when unusual. PM and UX: header chip, always says who | **the activity block** (row plus leading headline segment), always says why, in person-neutral words (a shared chat is read by someone who did not start it). UX had recommended the chip; the product owner moved it into the activity block on 2026-11-13 so there is one place that shows what happened |
| Rename of "Show thinking analysis" | researcher: Reasoning / Gedankengang | "Thinking process" / "Denkprozess", the product's own settings vocabulary |
| "Read" | PM: leave for research | retire the hit-level marker, rows say "Opened", headline counts "N opened"; a page shown once (merge hit and row) comes later |
| Technical details toggle | PM: end of list, `aria-pressed` | top of the open list, finished turns only, `role="switch"`, remembered |

## What it costs (measured in Chromium, activity block height)

| Run | Today | Flat list (recommended) | Sketch (sections in run order) |
|---|---|---|---|
| Screenshot run, 640 px | 350 px | 310 px | 384 px |
| Screenshot run, 320 px | 558 px | 638 px | 694 px |
| One web search, 640 px | 168 px | 168 px | one more header line |
| One web search, 320 px | 212 px | 306 px | |

- At 320 px the recommended list is **taller than today**. Today's hit titles are truncated to one line; the proposal wraps them to two, so no title is cut off. If the Outlook pane complains, clamp the title to one line. That is a one-class change.
- On the screenshot run the flat list loses one thing to the sketch: the three page openings still sit under the project search, marked only by a globe icon and the words "Opened web page", until the later merge folds them into their hits.
- 24 px targets make each hit 6 px taller at 640 px.
- **Skills in the activity block** add one row per skill and one segment to the collapsed line, which wraps. Skills in force from the start (started manually, set by the app, kept from an earlier message) are the first rows; a skill the model chooses appears where it happened. Measured on the screenshot run with one skill row: the expanded block is 354 px at 640 px (+44 px, the row itself is 28 px) and 686 px at 320 px (+48 px), and the collapsed line wraps to two lines at 640 px (36 px instead of 20). With three or more skills the collapsed line names them without the reasons. A skill-only answer now has an activity block it did not have before. A chat-launched workflow keeps its own indicator above the answer; workflows are not in the timeline today and merging them is a separate redesign.

## Decisions for the product owner

1. **Expanded list:** flat with origin in every row (recommended), or the sketch of one section per origin change?
2. **Chats stored before the change:** clean break (recommended; it matches the footer-chip decision), or a compatibility mapping? CLAUDE.md requires your call. Clean break means old chats show a neutral "2 searches · 5 results" segment and no origin words.
3. **Technical details:** for everyone, off by default (recommended), or admins only?
4. **Skill wording:** person-neutral "started manually" (recommended), or "started by you"? And are skills carried over from earlier messages shown in the first slice (needs one new server frame) or the next?
5. **Footer noun for admin-configured sources:** "Document sources" instead of "Documents", so "documents" never means a project (one string).
6. **Thinking process:** rename and restyle in this slice (recommended), or the label and `aria-expanded` fix only? Merging both disclosures into one "How this answer was made" block is a separate ticket.
7. **`activityScope` stays on the wire for one release** with no new reader (recommended), so cached extension and Outlook bundles keep working.
8. **Footer for answers whose only retrieval was `read_url`:** count it as Web (recommended, if the check below confirms it).
9. **How many origins the collapsed line names before "+N":** two, like the footer chip (as specced), or up to four, since the finished line wraps instead of truncating? With three or more origins a sighted reader does not see the hidden names in the collapsed line.

## Scope

Three shippable pull requests, additive on the wire, no config migration (see `02-product-brief.md` section 8 and `03-ux-brief.md` sections 7 and 9):

1. **Server and shared (M).** `activityOrigin` on `tool/started`, the `args` progress frames and the ledger, derived from the classifier the footer already uses. A server-declared result count per search (so "no results" is never inferred from an empty list). A declared outcome for reads that delivered no text (G10), so "N opened" never counts an empty read; `read_url` with `offset` at or past the end of a page is such a case today. Origin on the synthesized native web-search row. `Source.origin`. `activatedBy: 'app'` (and `'chat'`). Stored and shared activity keeps the new fields; shares carry the origin type but no project or profile names.
2. **Client activity (M).** Segments, streaming wording, rows, "no results", skill rows and a leading skills segment, the Technical details switch, the Thinking process button, EN/DE strings, announcer text.
3. **Client sources (S).** Origin on cards and the summary line.

Next: origin filter pills, project and profile names on rows (with share scrubbing), merge of hit and read rows, the metrics in `02-product-brief.md` section 9.

## Verify first

Found by reading code, not by running it:

- **V1.** The stored activity whitelist (`server/services/chat/runActivity.js`, `boundToolItem`) has no `integration`. Reopen a chat after a web search: is "Brave Search" gone?
- **V2.** `classifyKnowledgeSource('read_url')` returns null. Paste a URL so that the model only calls `read_url`: does the footer say "Model knowledge"?
- **V3.** Skills carried over from an earlier turn emit no frame. Does any UI show them?
- **V4.** In the screenshot run, did the project search return zero hits, or were its hits not attached to the row? The screenshot cannot tell.
- **V5.** Hit and later fetch share one source id for web results (needed for the merge).
- Run the Tailwind colour pairs against a real build, and look at the real page at 640 and 320 px in Chromium, Firefox and Safari. The mockup mirrors the classes in plain CSS.
- Real users: the label test and the structure test in `03-ux-brief.md` section 8. The falsifiable rule for the structure decision: if fewer than 5 of 6 participants say "web" for the three page openings in the flat list, or any compliance participant is confidently wrong, switch to the sketch.

## Related

- `concepts/2026-11-12 Answer Footer Basis Chip.md` (the shared origin vocabulary)
- `concepts/web-search-sources-and-citations/README.md`, `docs/answer-sources.md`
- Issues #3038 (tools declare what they are), #3521, #3619
