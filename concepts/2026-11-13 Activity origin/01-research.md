# UX research: "Where did this answer come from?" in iHub Apps chat

Author role: senior UX researcher (enterprise search / AI assistants).
Inputs: fact base `00-fact-base.md`, the screenshot `images/1.png`, and the code it points to
(`ToolActivity.jsx`, `activityHeadline.js`, `AnswerSources.jsx`, `ChatMessage.jsx`, `shared/run/toolActivity.js`,
`server/utils/toolDisplay.js`, `shared/i18n/{en,de}.json`).

---

## 1. Method and limits (read this first)

I cannot reach real users. Nothing in this document is user data. No quote, percentage or "N of M users" is real.

| Part | What it is | Evidence status |
|---|---|---|
| A. Heuristic evaluation + cognitive walkthrough | Nielsen's 10 heuristics plus AI-transparency heuristics (visibility of system status, match with the real world, recognition over recall, consistency and standards, trust calibration, provenance legibility). Applied to one screenshot and the code. Every finding points to a visible element or a code line. | **Evidence-based** (observed facts + expert judgment). Confidence is stated per finding. |
| B. Persona walkthroughs | Four personas (plus an optional screen-reader persona) role-played against a scripted interview. Every answer is tagged `[SIMULATED HYPOTHESIS]`. | **Simulated.** These are predictions of where comprehension might fail and why. They are hypotheses to test, not findings. |
| C. Vocabulary test | Expert linguistic judgment of EN and DE labels (false friends, register, scannability). | **Expert judgment, untested.** DE verdicts need native-speaker review and a label test (see section 7). |
| D. Validation plan | A one-week plan for real users. | **Plan**, not results. |

Other limits:

- One screenshot, one run (English UI, German answer text). No skill appears in it, so skill findings come from code, not from the picture.
- I did not run the app, a screen reader or the other surfaces (Outlook 320px pane, extension, phone). Layout claims for those are calculations from the code (flagged).
- I do not know whether the project search in the screenshot returned zero hits or its hits were never attached (see F7). That is a verification item for engineering.
- Severity scale: **4** = produces a wrong belief on a trust-critical question or blocks the task. **3** = major: likely error or long task for many users. **2** = minor friction or inconsistency. **1** = cosmetic.
- Confidence: **high** = directly visible or directly in code. **med** = follows from code plus a design-principle argument. **low** = plausible, needs user data.

---

## 2. Findings (heuristic evaluation)

### What works today (keep it)

| ID | Strength | Evidence |
|---|---|---|
| S1 | The query is shown as a readable chip ("IntraFind iFinder6"). It tells the user what the model asked. | Screenshot rows 1 and 2; `ToolActivity.jsx:271-278` |
| S2 | Hits are scannable: title + host, linked. | Screenshot row 1 hits; `SourceRow` `ToolActivity.jsx:544-590` |
| S3 | The footer already has a server-decided origin vocabulary (Project, Web, iFinder, Model knowledge) with icon + noun, not colour. This is the clearest origin signal in the product today. | `answerBasisModel.js:21-33`, `#3619` |
| S4 | The server decides what a call is. The client does not guess from tool ids. The right architecture for a fix. | `toolDisplay.js:30-75`; CLAUDE.md "Server Decides" |
| S5 | The activity list collapses to one line after the answer and is kept as provenance. | `ToolActivity.jsx:68-69` (`open = expanded ?? loading`) |

### Findings table

| ID | Finding | Evidence (visible element or code line) | Sev | Conf |
|---|---|---|---|---|
| **F1** | **Rows do not say where they searched.** Row 1 (web) and row 2 (project) carry the identical label "Searched for". The only origin marker is the Brave Search chip, and it exists only for integration tools. The project row has no marker at all, so the two origins are distinguished by the presence or absence of a chip. The reader has to infer the project row's origin from what is missing. | Screenshot rows 1-2. `ToolActivity.jsx:266-270` (label), `:284` (chip only when `item.integration`), `:467-478`. `scope` exists on the row but is never rendered (`toolActivity.js:348-351`). | **4** | high |
| **F2** | **The word "documents" hides three different origins.** The server collapses `ifinder`, `project` and `sources` into `activityScope: 'documents'` before sending. The client can therefore only say "Searched documents". A project search, an iFinder search and a configured-source search read the same, and the compliance-relevant distinction (which internal system) is lost. | `toolDisplay.js:58-66` (`activityScopeOf`). `activityHeadline.js:255-257`. The server knows the finer value (`classifyToolKnowledgeSource`, `knowledgeSourceSeam.js:33`). | **4** | high |
| **F3** | **The headline is a run-on string whose parts do not belong together.** "Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search" uses one separator for scope phrases, counts and a provider name. Counts are aggregated across origins ("2 searches" = web + project; "5 results" = only the web hits, since the project search shows none), so no number can be attributed to an origin. The provider is appended last, after the counts, so it reads like another metric rather than "the web search ran on Brave". | Screenshot headline. `activityHeadline.js:240-267` (parts), `:300-314` (`finishedHeadline` join, integrations last at `:311-312`). | **4** | high |
| **F4** | **The headline icon is one globe for a mixed turn.** `lookedAtIcon` returns `globe-alt` unless every row is a documents row. A turn that also searched internal project documents shows only the web icon, which is the glyph a 5-second reader trusts most. For a compliance reader this is a systematic misread in the unsafe direction ("only the public web" when internal content was also used, or the reverse for iFinder-only turns). | Screenshot (globe). `activityHeadline.js:338-344`. | 3 | high |
| **F5** | **The flat time-ordered list reads as a hierarchy that is false.** Rows 3-5 (web page reads) come after row 2 (project search) at the same indent as the searches. Proximity makes them look like the project search's children. Meanwhile row 1's hits are indented under row 1, so hits are nested but reads are not. The reads also carry a document glyph although they are web pages (host intrafind.com). Which read belongs to which search is not recoverable from the layout. | Screenshot rows 2-5. `ToolActivity.jsx:128-136` (single `<ol>`, `space-y-2`), `:309` (`fallback="document-text"`). `toolActivity.js:322-345` (`callsInOrder` is chronological). | 3 | high |
| **F6** | **"Read" has at least five meanings and the numbers do not reconcile.** (1) green eye + "Read" on a search hit; (2) the verb "Read" on a fetch row; (3) "5 pages read" in the headline; (4) "Read for this answer" section in the sources panel; (5) "Read" status on a source card and, in the footer, "all documents read" (knowledge mode). The screenshot shows 5 pages read but 3 read rows, and the same page appears twice (as a hit marked Read and as a Read row with 1334 words). The hit-level "Read" comes from the provider's `extractContent` (3000 chars), the row-level "Read" from a 10000-char fetch. Both are labelled identically, so reading depth is hidden. That overstates evidence for a trust decision. | Screenshot hits vs rows 3-5. `ToolActivity.jsx:567-579` (hit marker), `:310-314` (row verb), `activityHeadline.js:173-178` (`countRead`), `AnswerSources.jsx:709-714` and `:1156-1198`. | 3 | high |
| **F7** | **A search that returns nothing is silent.** Results are shown only when `item.sources.length > 0`. Row 2 (project search) shows no count and no hits. The user cannot tell "found nothing" from "found something that is not shown", and so cannot tell whether project content fed the answer. The headline "5 results" is web-only for the same reason. **Verify with engineering which of the two happened in this run.** | Screenshot row 2. `ToolActivity.jsx:279-283`, `:289-295`. | 3 | med |
| **F8** | **Raw tool arguments are shown to everyone, as the loudest element.** `extractContent true`, `maxResults 5`, `contentMaxLength 3000`, `maxLength 10000`, `offset 0`, `limit 8` appear as camelCase identifiers with monospace chips on every row. They are not localised, not explained, and meaningless to a non-technical user ("limit 8" of what?). They are useful to the admin persona, so the answer is progressive disclosure, not removal. Screen readers read them as a term/definition list. | Screenshot rows 1, 2, 3-5. `ToolActivity.jsx:484-510` (`ItemDetails`). `toolActivity.js:133-157` (`toolDetails`: every argument). | 3 | high |
| **F9** | **A skill is shown twice, differently, and the top version means nothing.** A purple pill with a sparkles icon per distinct skill sits above everything (non-interactive `<div>`, no actor, no timing). The same skill appears again in the activity list as "Used skill [name] started by you / loaded by the model", and in the headline as "N skill(s)". The pill has the shape language of a clickable chip but does nothing. A skill the model loads twice shows twice in the list and once in the pills. | `ChatMessage.jsx:971-984` (pills from `distinctSkills`, `:284`). `ToolActivity.jsx:228-251` (`SkillRow`). `activityHeadline.js:303-306`. `toolActivity.js:21-24` (comment documents the one-vs-two mismatch). | 3 | high |
| **F10** | **"Who triggered this" is answered for skills only, and only in engineering vocabulary.** Searches and reads carry no actor. Three actors exist (the user, the model, the app configuration) but the UI distinguishes two and only for skills. "loaded by the model" is jargon (users do not know a model "loads" a skill). Stating "by the model" on every row would be noise, because it is the default. The informative case is the exception (the user started it, or the app forced it). | `ToolActivity.jsx:238-247`. `toolActivity.js:226-230` (`activatedBy`). Searches/fetches: no such field (`toolActivity.js:373-400`). | 2 | med |
| **F11** | **The sources panel shows sources, not origin; host and icon are weak origin signals.** A card shows a favicon or file icon, the site, a date and, for iFinder only, a scope chip with a folder icon. There is no "Web / Project X / iFinder / Jira" marker. `ScopeFilter` filters by iFinder search profile, not by origin. A project document and an iFinder document look the same (document icon by file type). The host is unreliable: in the screenshot the "web" results are `intrafind.com`, which a reader at that company can easily take for internal content. | `AnswerSources.jsx:899-933` (card header), `:791-824` (`ScopeFilter`), `:1233-1286` (`SourceIcon` distinguishes only page/document/item). `sourcesView.js:46-48` (`scopeLabelOf` empty for web and project). | 3 | high |
| **F12** | **Three vocabularies and colliding icons.** Activity says `scope: web|documents`; sources say `provider`/`kind`; the footer says `answerBasis.kind` (project, web, ifinder, documents, ...). The footer has a separate kind `documents`, so "Searched documents" in the activity and "Documents" in the footer may not even mean the same thing (verify). Icons collide: `folder` = Project in the footer but = iFinder search profile in the panel header and card; `link` = integration in the footer/chip, hyperlink elsewhere; `document-text` = iFinder in the footer, generic "document" on web-page Read rows. | `answerBasisModel.js:21-33`. `AnswerSources.jsx:664`, `:924`. `ToolActivity.jsx:309`, `:474`. i18n `chatMessage.answerBasis.kind.*`. | 3 | high |
| **F13** | **The collapsed headline is single-line and truncated, and the most specific part is last.** The label is `truncate` on one line. In the 320px Outlook pane, and in German (about 30% longer), the tail ("5 Seiten gelesen · Brave Search") is the first thing to be cut, which is exactly the provider and the read count. *Calculation, not measurement:* the DE headline is about 97 characters at 12px, which is roughly 600px against about 250px usable in the pane. | `ToolActivity.jsx:82-91` (`min-w-0 truncate`, text only in `title`). DE strings `toolActivity.*`. | 2 | med |
| **F14** | **"Show thinking analysis" is a second, unrelated disclosure with a different affordance.** An underlined 12px text link with no chevron and no `aria-expanded`, stacked directly above the activity button (icon, chevron, `aria-expanded`). Two disclosures about "how this was made", two interaction styles, two vocabularies. "Thinking analysis" is also an unnatural phrase in EN, and "Denkanalyse" is not idiomatic German. This is the open follow-up of #3521. | Screenshot top-left. `ChatMessage.jsx:998-1002` (plain `<button className="underline">`, no `aria-expanded`). i18n `pages.appChat.showThoughts`. | 2 | high |
| **F15** | **"truncated" is amber and explained only in a hover tooltip.** Amber reads as a warning. The explanation ("The page is longer than what was read") lives in `title`, which is unavailable on touch, to many keyboard users and inconsistently to screen readers. "1334 words read" is a unit users cannot evaluate. | Screenshot row 3. `ToolActivity.jsx:334-341`. | 2 | high |
| **F16** | **Same noun, different denominators.** The headline "5 results" counts unique sources on search rows (`countSources`). The footer tile "N results" counts cited + read + considered (`total`). They coincide in this screenshot but can diverge, for example for provider-run web search whose sources are not attached to a row. "2 searches" adds web and project. | `activityHeadline.js:180-182`, `:264-265`. `AnswerSources.jsx:118`, `:143`. | 2 | med |
| **F17** | **Screen-reader path is long and has no structure.** No headings or group names, so a screen-reader user must traverse every row to learn what the globe tells a sighted user. The args list is read as `term definition` pairs. The hit marker is read after the link ("... intrafind.com Read"), which is ambiguous. The Brave chip's meaning is in a `title`. Unverified: I did not run a screen reader. | `ToolActivity.jsx:128-136`, `:488-508`, `:567-579`, `:471-476`. Component doc `:44-47` (list is `aria-live="off"`, a separate `RunAnnouncer` speaks). | 2 | med |
| **F18** | **DE register is mixed, and some DE labels are calques.** `skillByUser` = "von dir gestartet" and `documentNoAccess` = "Du hast keinen Zugriff" use informal *du*; `attachedToMail` = "Ihre E-Mail" and `pageReadLimit` = "bitten Sie" use formal *Sie*. For regulated German enterprises this inconsistency is noticeable. "Denkanalyse" and "5 Seiten gelesen" (pages of a document vs web pages) are weak. | `de.json` keys above. | 2 | high |

Cross-cutting heuristic summary:

- **Visibility of system status / provenance:** F1, F2, F4, F7 (where and with what result are not visible).
- **Match with the real world:** F2, F6, F9, F10, F18 (engineering words: "loaded by the model", "documents", "Read").
- **Consistency and standards:** F5, F11, F12, F14, F16.
- **Recognition over recall:** F1, F3, F5 (reader must reconstruct origin from absences and order).
- **Aesthetic and minimalist design:** F3, F8, F9.
- **Trust calibration:** F4, F6, F7, F11 (the UI can create a more or less confident belief than the evidence supports).

---

## 3. Persona walkthroughs (all `[SIMULATED HYPOTHESIS]`)

Method note: each persona is a thought experiment built from the screenshot and the code. "Think-aloud" lines are paraphrased hypotheses, not quotes. A "predicted" outcome is a hypothesis about whether the screen supports the task.

Tasks: **T1** Where did this answer come from? **T2** Did it use our internal project or the public web? **T3** Which result came from which place? **T4** Who started the skill, was it me? **T5** What does "Searched documents" mean? **T6** What does "Read" mean (hit marker, Read rows, "5 pages read")?

### P1. German knowledge worker in a regulated company, daily user, not technical

Assumed profile: uses the chat for drafting and lookups, knows the app has "Projects", has never read the activity list on purpose.

**5-second test (collapsed or open line)** `[SIMULATED HYPOTHESIS]`
- "A globe, so it looked something up on the internet. Some documents too. Something called Brave." Stops at "Brave Search". Reads the headline as a list of facts, not as two separate sources.

| Task | Predicted | Why (visible cause) |
|---|---|---|
| T1 | Partial | Gets "internet and some documents". Cannot say which documents. (F1, F2) |
| T2 | Fail or partial | "Documents" could mean *our* documents, *the pages on the web*, or the project. The project row has no hits and no origin, so she cannot confirm the project was used. Predicted risk: believes "project used" (word "documents" present) or "nothing from the project" (row 2 is empty). Either belief is unsupported. (F2, F7, F1) |
| T3 | Fail | Only row 1 has hits, so predicted "everything is from the web". Hits at intrafind.com could look internal to someone at that company. (F1, F5, F11) |
| T4 | Partial (fixture with skill) | Understands "von dir gestartet". "Vom Modell geladen" is understood as "the AI chose it", but "geladen" is odd. The purple pill above looks like the *app name* or a mode she selected, and she may not link it to the row. (F9, F10, F18) |
| T5 | Partial | "Dokumente durchsucht" = "looked at documents", no idea which. (F2) |
| T6 | Fail | "Gelesen" next to a link looks like an inbox read-state ("did *I* read it?"). Reads "5 Seiten gelesen" but sees 3 read rows. (F6) |

Likely overall: ignores the activity list, relies on the answer text and the footer chip. The list adds uncertainty rather than trust.

### P2. Compliance / data-protection officer

Assumed profile: must answer "did internal documents or the public web feed this answer, and what left the company?". Reads the screen as evidence.

**5-second test** `[SIMULATED HYPOTHESIS]`
- "Globe icon: so web. 'Brave Search' is a third party, what did it receive? 'Documents': which ones? I can't tell." Wants a clean split: internal / external.

| Task | Predicted | Why |
|---|---|---|
| T1 | Partial | Gets the two classes only at the level of words, no names. (F2, F3) |
| T2 | Fail on confidence | Wants a yes/no per origin. Gets a globe (web) and "documents" (unspecified). Row 2 has no origin marker and no result count; he cannot distinguish "project searched, nothing found" from "project searched, hits hidden". He would fall back to the footer chip, which is the better signal but describes *basis*, not what was queried. (F1, F2, F4, F7) |
| T3 | Fail | The panel does not show origin per source; the only origin cue is host or a file icon. For project documents no host exists. (F11) |
| T4 | n/a | Cares about *who authorised an action* for audit purposes: "the user started it" vs "the model decided" matters. (F10) |
| T5 | Fail | Needs the system, not the category. (F2) |
| T6 | Partial | Cares about "was my document's text sent to the model?", not "read". The word "Read" does not answer that, and the 3000-char excerpt vs 10000-char fetch distinction is invisible. (F6) |

Extra concern (vocabulary): the chip tooltip says "Data from Brave Search". For him the privacy question is the *opposite direction*: what was *sent to* Brave (the query). "Data from" frames the provider as a source, not as a recipient. (`ToolActivity.jsx:472`)

### P3. Power user: skills (`/skill-name`) and projects

**5-second test** `[SIMULATED HYPOTHESIS]`
- "I typed `/contract-review`. I see a purple pill up top and the list also says used skill. Are those two skills? And what is 'limit 8'?"

| Task | Predicted | Why |
|---|---|---|
| T1 | Pass | Reads the list, can reconstruct. Long. |
| T2 | Partial | Knows what a project is, but sees no project *name* on the row; the chip "iFinder6" is the query and could be mistaken for the place searched. (F1) |
| T3 | Partial | Can match hits to row 1 only. Cannot see which read belongs to which search. (F5) |
| T4 | Pass for the row; confusion for the pill | "Started by you" is clear to him. The pill duplicates it and has no actor. When the model also loads a second skill, pills and rows disagree in count. (F9, F10) |
| T5 | Partial | Guesses "project" but wants the name. (F2) |
| T6 | Partial | Understands read vs hit, but "Read" on the hit and "Read" on three rows look like the same fact. (F6) |

He is the persona most likely to *like* query chips and to want *project name* and *knowledge mode* (loaded / searched / pinned) in the activity.

### P4. Admin who configures integrations and debugs "why did it answer that"

**5-second test** `[SIMULATED HYPOTHESIS]`
- "Good that I see the arguments. But which tool id is this? Which provider config? Which project was searched? Did the search return 0 hits or did it fail silently?"

| Task | Predicted | Why |
|---|---|---|
| T1 | Pass | Can see args and rows. |
| T2 | Partial | Needs project identity and result count; row 2 has neither. (F1, F7) |
| T3 | Partial | Hits for web only. (F5, F11) |
| T4 | Partial | Wants to know whether the app *forced* the skill or the model chose it. Only user/model is shown. (F10) |
| T5 | Fail | "Documents" is not a system. Needs `ifinder` vs `project` vs `source_*`; the server has it (F2). |
| T6 | Pass | Knows what `extractContent` and `maxLength` do. |

The admin needs what P1 and P2 do not: arguments, tool id, duration, and zero-result states. This is why F8 is "disclose progressively", not "delete".

### P5 (optional). Screen-reader user, reading the activity list

Reading order from the DOM `[SIMULATED HYPOTHESIS]`:
1. Skill pill text (no role, no label) -> 2. "Show thinking analysis" button (no expanded state announced) -> 3. headline button "Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search, collapsed/expanded" -> 4. each row: "Searched for", query, "5 results", "Brave Search", then `extractContent true maxResults 5 contentMaxLength 3000`, then five links each ending "... intrafind.com Read" -> 5. row 2 -> 6. three read rows with `maxLength 10000 offset 0`.

Predicted: about 40 stops to learn what a sighted user gets from the globe. T2 needs a full traversal, there are no headings to jump by, and "Read" after each link is ambiguous (F17, F14, F9). The list is `aria-live="off"`, so nothing helps unless the `RunAnnouncer` says the origin. Needs a real screen-reader test.

### Predicted success matrix (simulated; Pass / Partial / Fail)

| Task | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| T1 Where from | Partial | Partial | Pass | Pass | Partial |
| T2 Project or web | **Fail** | **Fail** | Partial | Partial | **Fail** |
| T3 Which result from where | **Fail** | **Fail** | Partial | Partial | **Fail** |
| T4 Who started the skill | Partial | n/a | Pass (row) / confused (pill) | Partial | Partial |
| T5 "Searched documents" | Partial | **Fail** | Partial | **Fail** | Partial |
| T6 "Read" | **Fail** | Partial | Partial | Pass | Fail |

The pattern to test: the trust-critical tasks (T2, T3) fail for exactly the personas who need them most (P1, P2), and the cause is the same for all (no origin on rows, sources and headline: F1, F2, F11).

---

## 4. Vocabulary verdicts (EN / DE)

Verdict key: **OK** keep; **Fix** keep the idea, change wording or placement; **Replace** the label misleads.
DE strings are the current `de.json` values unless marked "candidate". DE verdicts are expert judgment and need a native-speaker review and a label test.

### Current labels

| Label (EN / current DE) | EN verdict | DE verdict | Issue (false friend, register, scan) | Direction |
|---|---|---|---|---|
| "Searched documents" / "Dokumente durchsucht" | **Replace** | **Replace** | False friend: "documents" is used for a **project** search (footer says "Project"). Also covers iFinder and `source_*` (F2). The footer has its own `documents` kind, so the same word may mean two things (F12). | Name the origin: "Searched project “X”", "Searched iFinder", "Searched the web". Never "documents" as an origin. |
| "Searched the web" / "Web durchsucht" | OK | Fix | EN is clear. DE is telegraphic (participle-only). "Im Web gesucht" reads more natural. "Web" vs "Internet": non-technical German users tend to say "Internet". Footer already uses "Web", so consistency favours "Web". **Test both.** | Keep EN. DE: "Im Web gesucht" (test vs "Im Internet gesucht"). |
| "Brave Search" chip with link icon / "Brave Search" | Fix | Fix | The provider name is fine. The *placement* (last, after counts) and the link icon (read as hyperlink, not "engine") are not (F3). Tooltip "Data from Brave Search" is direction-ambiguous for compliance (P2). | Attach to the Web group: "via Brave Search" / "über Brave Search". Icon: not `link`. |
| "5 results" / "5 Ergebnisse" | OK in a group, **Fix** as a headline total | OK | Fine inside an origin group. At headline level it is an aggregate without an origin (F3, F16). DE "Treffer" is more usual for search hits and may match the iFinder UI. **Check iFinder terminology.** | Per origin, never a global total in the headline. |
| "5 pages read" / "5 Seiten gelesen" | **Fix** | **Replace** | EN "pages" is ambiguous with document pages. DE "Seiten" = pages of a document *or* web pages (false friend with PDFs). Count also disagrees with the 3 read rows (F6). | "5 web pages" (opened) or drop the count. DE: "Webseiten" at minimum. |
| "Read" (verb on a row) / "Gelesen" | Fix | **Replace** | EN: ok as a verb for a fetch row, wrong as a hit-state marker with an eye icon. DE: "Gelesen" as a state label evokes an inbox/chat read-receipt ("seen by me"), not "the model fetched this". Eye icon reinforces "viewed". (F6) | Separate two ideas: "Opened" (full fetch) and "Excerpt" (snippet from the search provider). Test labels (section 7). |
| "Project" / "Projekt" (footer, `sources.project`) | OK | OK | Correct noun. Weak without a name; two projects look identical. Generic workplace meaning of "project" is a risk for users who do not use the Projects feature. | "Project “Q3 contracts”". The server already knows names (`openProjectNamed`). |
| "Used skill [X] started by you" / "Skill verwendet [X] von dir gestartet" | Fix | Fix | "Skill" is accepted product vocabulary. "started by you" is clear. DE: "dir" breaks register (F18). | "Skill: X" plus an actor only when it is not the default (see below). |
| "loaded by the model" / "vom Modell geladen" | **Replace** | **Replace** | Engineering word ("load"). Users do not know a skill is "loaded". It is also the default case, so it adds noise (F10). | Drop it. Say "You started" only when true, and "the app enabled it" only when the app forced it. |
| "Show thinking analysis" / "Denkanalyse anzeigen" | Fix | **Replace** | EN: "thinking analysis" is odd (analysis *of* thinking?); "reasoning" is the standard term. DE: "Denkanalyse" is not idiomatic; "Gedankengang" is. Matches the PO's own phrase "thought chain". (F14) | EN "Show reasoning". DE "Gedankengang anzeigen". |
| "truncated" / "gekürzt" | Fix | Fix | Amber plus tooltip-only explanation (F15). "gekürzt" implies someone shortened it. | "Partly read" / "Nur teilweise gelesen", visible, neutral colour. |
| "N words read" / "N Wörter gelesen" | Fix | Fix | Unit that users cannot evaluate. | Move to details. |
| "Data from {{name}}" (chip tooltip) / "Daten aus {{name}}" | Fix | Fix | Wrong direction for the privacy reading (query is *sent to* the provider). Tooltip only. | Visible "via {{name}}". |
| "Searched for" / "Gesucht nach" (row) | OK | OK | The grammar is fine, but with an identical label on every origin it gives no discrimination (F1). Needs an origin around it, not a new label. | Keep as the *row* label under an origin heading. |
| "Sources", "Cited in this answer", "Read for this answer", "Also considered" | OK | OK | "Sources" vs "Results" was settled in #3521. "Read for this answer" adds a sixth "read" meaning (F6). | Keep; consider "Used to write this answer". |

### Candidate labels (proposal words)

| Candidate | EN | DE (candidate) | Verdict and caveats |
|---|---|---|---|
| "Searched the web" | Clear, past tense. | "Im Web gesucht" | **Good** as an action. As a group header, prefer a noun phrase ("Web"), because the header must also work while streaming. |
| "Search in web" (the PO's wording) | Not idiomatic English. | n/a | Use "Searched the web" or the noun "Web search". |
| "Searched project X" | Clear when X is the real name. | „Projekt „X“ durchsucht“ | **Good.** Removes the false friend. Needs the name from the server. Fallback "Searched the project" when the name is missing. |
| "Searched iFinder" | Clear to IntraFind customers. In a given company the system may have a local name. | "In iFinder gesucht" | **OK**, product name is shared vocabulary. Add the search profile ("iFinder · Contracts") when present (S: panel scope chip already does it). |
| "Skill: X" | Neutral, short. | "Skill: X" | **Good** as one label. Actor suffix only for non-default ("You started"). |
| "Web · Brave Search" | Clear as a pair. | "Web · Brave Search" | **Good**: puts provider next to origin. |
| "Internal / External" as a top-level split | Matches the compliance mental model. | "Intern / Extern" | **Promising, untested.** Could be a badge on the origin icon. Test whether users find "internal" accurate for project vs iFinder. |

False friends to avoid (collected): "documents" for a project; "pages" for web pages (document pages); "Read" as a state (inbox read-state); "loaded" for a skill; "analysis" for reasoning; "Data from" for a provider that receives the query.

---

## 5. Mental-model summary (hypotheses, not findings)

How users probably model "where answers come from". All of these are hypotheses to test.

1. **H1: three buckets, with one decision that matters.** "From the AI's own knowledge", "from the internet", "from our stuff". The critical line for German regulated users is **internal vs external**, with the specific internal system second. The footer chip already speaks this language (S3). The activity list does not.
2. **H2: origin is a property of a source, not of a step.** Users think "this link is from the web, that document is from project X". They do not think "tool call 2 ran against the knowledge provider". Origin must live on the source card and the citation list first, and in the activity log second.
3. **H3: sources are things you can open and check; searches are process.** Users want to go from a claim to a source to its origin. They will not read a log to learn the origin.
4. **H4: "search" vs "read" is mostly an engineering distinction.** For most users both are "looked at". The question that matters to P2 is data-flow ("did the content of my document go to the model?"), not "read". "Read" as currently used answers neither.
5. **H5: proximity means causality.** Users read a vertical list as a story ("it searched the project, then it read these pages because of that"). The flat list tells a false story (F5).
6. **H6: agency matters for skills more than for searches.** A skill is felt as "a mode I picked" or "a thing the AI decided to do to me". Surprise ("I did not ask for that") is the failure mode, so the *non-default* actor is the informative signal. For searches the actor is almost always the model and rarely worth a word.
7. **H7: absence is read as meaning.** A row without a chip or result count reads as "something went wrong" or "nothing found", not as "UI did not show it" (F1, F7).
8. **H8: the footer chip is where users look for the verdict; the activity list is where they look for the proof.** The two must agree word for word (F12).

---

## 6. Design implications (ranked)

Ranked by severity, breadth and effort. Each is tied to finding IDs. The product-owner decisions are marked **[PO]**.

1. **Make *origin* a first-class, server-sent attribute and use one vocabulary on all three surfaces.** Carry the finer origin the server already knows (`websearch / ifinder / project / sources / integration`) on `tool/started`, aligned with the footer's `answerBasis` kinds (icon + noun, project and profile names where known, provider where known). The client stops collapsing to `web|documents` and never infers it. Fixes the root cause of F1, F2, F11, F12, F16. **[PO]** `activityScope` is replaced or kept alongside (clean break vs additive shim). CLAUDE.md requires the PO to choose; I recommend additive field plus removal of the client's use of `scope`.
2. **Group the activity list by origin, not by time.** Group header = origin icon + origin noun (+ project/profile name) + provider ("via Brave Search") + result count. Rows inside: action + query chip. Reads and hits nest under the group they belong to. Order groups by first use. **[PO]** whether internal groups should sort before external ones; test it (section 7). Fixes F1, F3, F5, F6, F17.
3. **Rewrite the collapsed headline as per-origin segments, never as a mixed aggregate.** Each segment is self-contained (icon + noun + its own count + provider). Drop "2 searches". Keep the icons visible when text is cut so that icons survive at 320px and in DE. Fixes F3, F4, F13, F16.
4. **Say "nothing found" explicitly, and verify what the project search returned in the screenshot run.** Show "0 results" or "No matches" per group. Fixes F7. (Engineering check first: no hits vs hits not attached.)
5. **Put origin on every source card, citation row and filter.** An origin chip (same icon + noun as the footer) on each card; a filter or grouping by origin in the panel, kept separate from the Cited / Read / Considered axis; fix the `folder` collision (profile vs project). Fixes F11, F12.
6. **Untangle "Read".** One concept per word: "Opened" (the page or document was fetched in full) vs "Excerpt" (a snippet from the provider). Show it once per source (merge the hit and the Read row). Remove the global "N pages read". DE avoids "Gelesen" as a state. Fixes F6, F15, F18.
7. **Hide raw arguments behind a Details toggle (closed by default; open for admins or a diagnostics mode).** Keep the query chip. Humanise the two or three that matter (result limit) or move all to Details. Fixes F8, F17.
8. **Give skills one representation.** Remove the top pill or turn it into a labelled, interactive element. Recommended: one skill line, first in the activity, "Skill: X"; add "You started" only for user-started skills, "The app enabled" only when forced; drop "loaded by the model". Resolve the one-vs-many mismatch. **[PO]** keep or remove the pill. Fixes F9, F10.
9. **Bring "thinking" into the same family.** Rename (EN "Reasoning", DE "Gedankengang"), same disclosure style (icon, chevron, `aria-expanded`), a sibling inside the activity block (follow-up of #3521). Fixes F14.
10. **Fix the small things in one batch:** visible text instead of tooltips ("partly read", "via Brave Search"), neutral colour for "partly read", DE register (Sie throughout, or du throughout; **[PO]** pick one), "Webseiten", heading structure and a one-sentence screen-reader summary per group. Fixes F13, F15, F17, F18.

Things not to do (from the evidence): do not add an actor ("by the model") to every row (F10, H6); do not distinguish origins by colour alone (decided in #3619); do not remove arguments for admins (P4).

---

## 7. Validation plan (real users, one week)

### Goal

Decide whether the proposal lets people correctly say *where an answer came from* and *which result came from where*, without expanding anything and without a confident wrong belief.

### Participants (6-8, recruited from real users and customers)

| Segment | n | Why |
|---|---|---|
| German-speaking knowledge workers in regulated companies, daily chat users | 2-3 | Primary users; DE strings |
| Compliance / data-protection / IT-security | 2 | The trust-critical readers |
| Power users (skills + projects) | 1-2 | Skill and project vocabulary |
| Admins | 1-2 | Diagnostics, args, zero-result cases |
| Screen-reader user (separate 30-min session) | 1 | F17; do not skip |

Sessions in German unless the participant prefers English. Include at least two participants who use the Outlook pane.

### Setup (day 1)

- **Fixtures, not live runs.** `buildToolActivity(run)` is a pure function of the run state, so record 6 anonymised run states and replay them. No backend work needed. Fixtures: (a) web only; (b) project only, with hits; (c) **mixed web + project (this screenshot)**; (d) project search with **zero hits**; (e) iFinder + web, with a search profile; (f) user-started skill + model-loaded skill + web.
- **Two builds behind a flag:** current vs proposal. Within-subject, counterbalanced order (half see current first). Same fixtures in both.
- Surfaces: desktop for all; 320px width for at least 3 sessions.

### Session script (45 min, moderated, think-aloud)

1. 5 min: background, how they use the chat, what they trust.
2. **5-second tests** x3 (fixtures c, d, f; alternating current/proposal): show the *collapsed* line plus footer for 5 seconds, hide, ask "Where did this answer come from? Was anything internal used?" Code free recall.
3. **Tasks** per fixture, no hints, ask for confidence (1-7) after each answer:
   - T1 Where did this come from?
   - T2 Did it use our internal project or the public web?
   - T3 Pick one result. Where is it from?
   - T4 Who started the skill? Was it you?
   - T5 "What does this line mean?" (point at "Searched documents" / the new group header)
   - T6 "What does this word mean?" (point at "Read" / the new label)
4. **Label test (10 min):** show 4-5 candidate labels per concept without context ("What would you expect to find if you clicked this?"): web, project, iFinder, "Opened/Excerpt" vs "Read", "Gedankengang" vs "Denkanalyse", "Web" vs "Internet", "Intern/Extern" badge.
5. 5 min debrief: "What would you need to see to trust this answer for a compliance decision?"

Moderator rules: no leading, no explaining the UI, record the first interpretation before any probing.

### Metrics and success criteria (proposed thresholds, agree them *before* the sessions)

n is 6-8, so these are patterns, not statistics. Use consistency across participants.

| Metric | Measure | Success for the proposal |
|---|---|---|
| T2 correctness (internal vs web) on the **mixed** fixture, collapsed line only | correct / incorrect / don't know | **at least 6 of 8** (5 of 6) correct |
| **Confident-wrong** answers (confidence 5-7 and wrong) on T2 and T3 | count | **0** on the mixed fixture |
| T3 correctness (origin of a chosen result) | correct / incorrect | at least 6 of 8 |
| Zero-hit fixture (d): participants correctly say "searched, found nothing" | correct / incorrect | at least 6 of 8 |
| T4 who started the skill | correct / incorrect | at least 7 of 8; nobody believes the pill is clickable or a choice they made |
| T6 "Read" interpretation | matches intended meaning | at least 6 of 8 (current build expected to be much lower) |
| Time on T2 | seconds, from collapsed line | median under 10 s, better than current |
| Single Ease Question per task | 1-7 | median at least 5.5 |
| Screen reader: steps to answer T2 | count | at least 50% fewer than current |
| Improvement over current | within-subject | proposal beats current on T2 and T3 for at least 6 of 8 participants |

### The go/no-go question

> **"Looking only at the collapsed line and the footer, without expanding anything: can the participant correctly say whether internal content (project / iFinder) and/or the public web was used for a mixed-origin answer, and are they right about it?"**

**Go:** at least 6 of 8 (or 5 of 6) are correct *and* there is no confident-wrong answer from a compliance participant. **No-go (iterate):** any compliance participant is confidently wrong, or the proposal does not beat the current build for most participants. A second no-go signal: compliance participants cannot find which sources came from the project in the panel.

### What to instrument in the product (privacy-safe: no query text, no document titles)

Client events (opt-in for the beta, aggregate only):
- `activity_headline_view` and dwell time on the collapsed line; `activity_toggle` (user vs auto), time from run end to first expand.
- `activity_group_expand` by origin kind; `activity_details_expand` (args toggle); `thinking_toggle`.
- `sources_panel_open` with entry point (tile, badge, footer, list row); `source_card_click` with `origin.kind`; `sources_filter_use` by origin.
- **Dead clicks** on non-interactive elements (the skill pill, the Brave chip, the project row): a direct measure of F9 and F1.
- Tooltip hover on `title` elements (proxy for "I needed the explanation").
- Runtime context: surface (main, Outlook, extension, phone), viewport width, language.

Server-side (baseline, before and after):
- Share of runs with two or more origins; share of project/iFinder searches with **zero hits** and whether sources were attached (answers F7); count of Read rows per run; share of runs with a skill, split by `activatedBy`.
- Admin support: tag "why did it answer that" tickets and count them per week as a leading indicator.

In-product micro-survey (beta only, after expanding the activity): "Was it clear where this answer came from?" (yes/no + optional reason). Keep it out of the main flow.

### Week plan

| Day | Work |
|---|---|
| 1 | Record and anonymise fixtures; flag the two builds; finish the script and thresholds; recruit/confirm. Engineering answers the F7 verification question. |
| 2-4 | 2-3 sessions per day; one note-taker; code answers the same evening. Screen-reader session on day 3. |
| 5 | Synthesis: per-task pass/fail grid, confident-wrong list, quote-level evidence *from real participants*, go/no-go, top 3 changes. |

### What would change my mind

- If P2-type participants answer T2 correctly from the *footer chip alone*, F4 and F1 are less urgent for the verdict and more about the proof layer (the activity list). The effort shifts to implications 5 and 6.
- If users do not open the activity list at all, the headline (implication 3) and the sources panel (implication 5) matter most, and grouping (implication 2) can be simplified.
- If "Intern/Extern" tests well as a badge, it could replace per-origin colour or a second icon and simplify implication 1.
