# Fact base: "Where did this answer come from?" in iHub Apps chat

Repo: `/workspace/ihub-apps` (read-only for you: DO NOT edit source, DO NOT commit). Screenshot of the problem:
`problem-run.png` in this folder.

## The request (from the product owner, verbatim intent)

1. When the LLM searches the web, projects, iFinder or any other integration, the chat must **state it out**.
2. In the **Sources panel** it must be clear which origin (web, iFinder, project, ...) each result comes from. Today we only see sources, not where from.
3. In the **thought chain** ("Show thinking analysis" + the activity list) we show "search" and "read docs", but it is not clear **who triggers it** and **where we search**. Web search and project search sit in the same flat timeline. Wish: split by type: first a "Search in web" group, then a "Search in projects" group, etc. Each with an icon for the origin, the action ("Search in web"), the hits, and at the end the provider ("Brave Search").
4. "This whole line is completely confusing." An **activated skill** is sometimes shown as its own chip on top, sometimes in the thought chain too.
5. Deliver a solution + design proposal after consulting senior PM, UX designer, UI designer and doing user research.

## What the screenshot shows (reading of it, check yourself)

- `Show thinking analysis` (underlined link, a separate disclosure for model reasoning).
- Headline: `globe | Searched the web · Searched documents · 2 searches · 5 results · 5 pages read · Brave Search ^`
  (one run-on string; "documents" here actually means a PROJECT search; the provider name "Brave Search" is appended at the very end and detached from the "web" part; "2 searches" adds a web and a project search together).
- Row 1 `Searched for [IntraFind iFinder6] 5 results [link-icon Brave Search]`, arg chips `extractContent true · maxResults 5 · contentMaxLength 3000`, then 5 hit links (title + host) each with a green eye "Read" marker.
- Row 2 `Searched for [iFinder6]`, arg chip `limit 8`. No origin chip, no result count, no hits. This is the project search.
- Rows 3-5 `Read <page title> intrafind.com 1334 words read [truncated]` with `maxLength 10000 offset 0`. These are WEB page reads (host intrafind.com) but they come AFTER the project search, so they look like children of it.
- "Read" appears three ways: as a marker on the 5 hits, as three separate read rows, and in "5 pages read" (the 5 comes from Brave `extractContent`, only 3 reads are rows).
- Raw tool arguments (`extractContent`, `maxLength`, `offset`, `limit`) are shown to everyone.

## What the code does today (verified by reading it)

- `client/src/features/chat/components/ToolActivity.jsx`: one flat `<ol>` timeline in time order. Row kinds: `SearchRow`, `FetchRow`, `ToolRow`, `SkillRow`. A `scope` ('web'|'documents') exists on search/fetch rows but is only used for the headline wording and icon; rows themselves show NO origin label. `IntegrationChip` ("link-icon + integration label", e.g. Brave Search) is shown only when the tool is an integration; a built-in project search has none.
- `client/src/features/chat/activityHeadline.js`: `finishedHeadline()` builds the run-on string from `searchedParts + readParts + skills + toolCalls + madeParts + integrations.join(', ')`.
- `shared/run/toolActivity.js` `buildToolActivity(run)` builds the rows. `skillRows(run)` makes one `skill` row per `tool/progress{skill.activation}` frame with `activatedBy: 'user'|'model'`.
- `client/src/features/chat/components/ChatMessage.jsx` ~L971: ALSO renders a separate purple pill per distinct skill above everything (`distinctSkills`, from `message.activeSkills`). So a skill is shown twice: pill on top + `SkillRow` ("Used skill [name] started by you / loaded by the model") in the activity list. Pills have no meaning of "who/when".
- Server decides what a call is: `server/utils/toolDisplay.js` sends on `tool/started`: `title`, `integration`, `activityKind` (search|fetch|tool), `activityScope` (web|documents only). Internally the server already knows the finer source: `classifyToolKnowledgeSource()` in `server/services/loop/seams/knowledgeSourceSeam.js` returns `websearch | ifinder | project | sources | integration | null`, but `activityScopeOf()` collapses it to web/documents before sending. Project knowledge tools are `knowledge_*`, iFinder `ifinder*`, configured sources `source_*`.
- Footer already has a server-decided vocabulary of source kinds: `run/ended.answerBasis: [{kind,label?}]`, kinds `project|web|ifinder|iassistant|documents|integration|email|file|audio|model|workflow`, icons in `client/src/features/chat/components/answerBasisModel.js` (`KIND_ICON`: folder, globe-alt, document-text, book-open, document-duplicate, link, mail, paper-clip, microphone, cpu-chip, cog). Chip reads `[✦ AI-generated | Based on 📁 Project · 🌐 Web ▾]`. (concepts/2026-11-12 Answer Footer Basis Chip.md)
- Sources panel: `client/src/features/chat/components/AnswerSources.jsx` (`SourcesPanel`, `SourceSection` "Cited in this answer / Read for this answer / Also considered", `SourceCard`, `ScopeFilter`). A `Source` (`shared/sources/source.js`) has `provider` ('web','ifinder','project', tool id, `mcp:<server>`), `kind` (page|document|item), `site`, `scopeName` (iFinder search profile), `provenance` (project doc: uploaded/picked/linked/written), `read`, `cited`. The card shows a favicon/file icon + `site` + date + optional scope chip ("folder-icon Contracts"). It does NOT show the origin (Web / Project X / iFinder / Jira). `ScopeFilter` filters only by integration scope (search profile), not by origin.
- THREE vocabularies for the same idea today: activity `scope` (web|documents), source `provider`/`kind`, footer `answerBasis.kind`. None is shared.
- Thinking: `message.thoughts` rendered as a separate "Show thinking analysis" underlined link (ChatMessage.jsx ~L1000), visually unrelated to ToolActivity.
- Existing i18n: `shared/i18n/en.json` + `de.json`, keys under `toolActivity.*`, `chatMessage.answerBasis.*`, `sources.*`. German is a first-class language (strings are ~30% longer).

## Prior decisions that bind the proposal (do not re-litigate; build on them)

- #3521 (closed): `ToolActivity` stays at the TOP of the answer (it is the only thing that stays put while text streams); the results tile ("N results") is at the END, next to the basis chip. Activity = "how it was made", tile = "evidence". "Results" not "sources" for the count. A "Restyling 'Show thinking analysis'" follow-up was left open.
- #3619 (closed): footer has ONE outlined basis chip; kinds are named by the server; colour does not distinguish kinds, icon + noun do; "Model knowledge", never "no sources"; clickable = outlined, status = tinted; targets >= 24px; nothing only in `title` tooltips.
- #3038 (open): tools should declare what they are; the client must not guess from tool ids. Our change is the natural next step: carry the finer origin the server already knows.
- CLAUDE.md: "Run Activity: the Server Decides, the Client Renders" (new distinctions = new server-sent fields, never inferred client-side from a tool id); additive API changes; **ask the user before backward-compat shims** (clean break vs compat is the product owner's call, state it as an open decision); EN + DE strings; a11y (WCAG 2.2 AA, 320px Outlook task pane, dark mode, reduced motion, screen readers; the chat log is a live region and ToolActivity is `aria-live="off"` with a separate `RunAnnouncer`); release note under `docs/releases/next/`.
- Surfaces: main chat, shared read-only chats, Outlook task pane (320px), browser extension side panel, phones.
- Users: knowledge workers in enterprises (German market, compliance-sensitive: "where does this come from / may I trust it / did it use my company's documents or the public web?"), plus admins who configure apps, tools, integrations, projects and need diagnostics.

## Ground rules for every reviewer

- Be concrete and opinionated; give a recommendation, not a survey. Cite files as `path:line` where you rely on code.
- Separate **observed facts** (screenshot, code, issues) from **hypotheses**. Never present an assumption as a finding.
- You are NOT a real user. Nothing you write may be presented as real user data.
- Keep to your role's deliverable, write it to the file path given in your task, and reply with a summary of at most 400 words.
