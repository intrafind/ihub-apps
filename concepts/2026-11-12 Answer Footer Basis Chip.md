# Answer footer: one basis chip instead of duplicate badges

Status: agreed design, not yet implemented.
Participants: product, UX and UI review, and the product owner's decisions (2026-11-12).

## Problem

In a project chat, the footer of each finished answer says the same thing several times:

```
[🔍 12 results ›]   [📁 Project Alpha · loaded in full]  [📄 Based on configured sources]  (ⓘ)
```

- The project appears twice. Two different server signals describe the same fact:
  - `knowledge/scope` produces the project badge.
  - `run/ended.knowledgeSources` contains `sources`, which produces "Based on configured sources".
    The server adds `sources` for project knowledge in two places:
    `PromptService.trackPromptSources` when project text is injected into the prompt, and
    `knowledgeSourceSeam` for `knowledge_*` tools.
- When the answer also used a web search, the project gets hidden inside "Based on multiple sources".
- "Configured sources" is admin wording. The word "sources" also clashes with the Sources panel that "N results" opens.
- "AI" is said twice:
  - on a plain answer as "✨ Based on AI knowledge";
  - on every answer by the separate icon-only ⓘ "AI generated: details" button.
- Visual issues:
  - Two identical purple pills next to each other.
  - 11 hues for 11 source types, several almost identical.
  - The project badge is a link but tinted, which breaks the #3521 rule that clickable elements are outlined. It has no focus ring.
  - All details sit in `title` tooltips, which keyboard and screen-reader users cannot reach.
  - At 320px (the Office taskpane) the row breaks into three lines.

## Decision

The footer row has at most three elements:

1. **Results entry:** `[🔍 N results ›]`. Outlined, unchanged. It shows the evidence, which is different from the basis of the answer.
2. **Basis chip:** one outlined button with a chevron. It states that the answer is AI-generated and what it is based on, and it opens the "About this answer" popover.
3. **Amber warning chip:** only when something in scope could not be used. It stays separate so a failure is not hidden inside a success statement.

The separate ⓘ provenance button is removed from the row. Its whole content moves into the basis chip's popover, unchanged.

```
Single project       [🔍 12 results ›]          [✦ AI-generated · based on 📁 Project Alpha ▾]
Project + web        [🔍 18 results ›]  [✦ AI-generated · based on 📁 Project Alpha + 🌐 Web ▾]
Several projects     [🔍 30 results ›]  [✦ AI-generated · based on 📁 Project Alpha + 2 more ▾]
No retrieval                                          [✦ AI-generated · no sources ▾]
Project unavailable           [✦ AI-generated · based on 📁 Project Alpha ▾] [⚠ Project Beta not used]
Workflow                                 [⚙ Workflow: Monthly report ▾]
320px taskpane       [🔍 18 results ›]
                                       [✦ AI · 📁 Project Al… + 🌐 ▾]
```

### Chip rules

- **Tone means how grounded the answer is, not the source type.** Use the shared `Badge` tones:
  - `info` (indigo): retrieved knowledge.
  - `neutral` (gray): no sources.
  - `warning` (amber): something degraded.
- **The icon carries the type:**
  - `folder` = project
  - `globe-alt` = web
  - `sparkles` = model
  - `document-text` = uploaded file only
  - a stack icon = admin-configured sources
- **Text is one line.**
  - Only the project-name segment truncates.
  - When the container is narrower than about 360px:
    - "AI-generated" shortens to "AI";
    - "based on" is hidden visually;
    - the full text stays in the accessible name.
- **More than two source types:** show the first, then "+ N more".

### Popover "About this answer"

It reuses the `ProvenanceInfo` disclosure pattern: a button with `aria-expanded`, a non-modal dialog, Escape closes it and returns focus to the button, and clicking outside closes it. It has three sections, each with a heading and a `<dl>`:

1. **Based on:**
   - Each contributing source with its mode in plain words: "all documents read", "searched for matching passages", "only pinned documents".
   - "Open project" link.
   - Diagnostics stay and are shown as muted text: knowledge mode, over budget, "the model cannot call tools".
2. **Not used:** projects that were in scope but did not contribute, with the reason.
3. **AI generated:** model, created, marking, content hash with copy, output id, note. This is the current `ProvenanceInfo` content.

Other details:

- No `title` tooltips anywhere in the footer.
- The amber chip has `role="status"` only on the newest answer, not on history.
- Popover sizing: `max-h` with scrolling, and its width fits the taskpane.

### Labels

| Case | EN | DE |
|---|---|---|
| Single project | AI-generated · based on Project Alpha | KI-generiert · basierend auf Project Alpha |
| Project + web | AI-generated · based on Project Alpha and web search | KI-generiert · basierend auf Project Alpha und Websuche |
| 3+ kinds or 2+ projects | AI-generated · based on Project Alpha and 2 more | KI-generiert · basierend auf Project Alpha und 2 weiteren |
| App-configured sources | AI-generated · based on {source name} (fallback "app documents") | KI-generiert · basierend auf {Name} (Fallback „App-Dokumenten“) |
| No retrieval | AI-generated · no sources | KI-generiert · ohne Quellen |
| Project unavailable | Project Alpha not used | Project Alpha nicht verwendet |
| Popover title | About this answer | Über diese Antwort |
| Popover sections | Based on / Not used / AI generated | Grundlage / Nicht verwendet / KI-generiert |

## Server changes

These follow the CLAUDE.md rule that the server decides and the client renders.

1. **New knowledge source value `project`** in `run/ended.knowledgeSources`.
   - Both project paths emit it in place of `sources`: `PromptService.trackPromptSources` and `knowledge_*` in `knowledgeSourceSeam`.
   - `sources` keeps only its admin meaning: `source_*` tools and app-level sources.
2. **`contributed: boolean` per project on `knowledge/scope`.**
   - It is `true` when the project's text was injected into the prompt, or its search tool returned content for this turn.
   - A project with `contributed: false` appears under "Not used", never as a basis.
3. **Additive only.** The new enum value is added to `sseV2.js` and `runLogEvents.js`, and `contributed` is optional. Consumers of `knowledgeSources` (run ledger, analytics) will see `project` for new runs.

## Decisions by the product owner

1. **Old stored messages: clean break.**
   - Messages stored before the change keep `answerSource.sources: ['sources']` together with their `knowledgeScope`.
   - No client compatibility rule is added. Old chats may still show the old pairing.
2. **The chip states "AI-generated".** The visible per-answer AI marker stays, now as the start of the basis chip. The separate ⓘ button is what goes away, and its content moves into the chip's popover. Nothing is removed from:
   - the first-turn notice (`AiFirstTurnNotice`);
   - the disclaimer banner below the composer (`AIDisclaimerBanner`);
   - the server's `provenance` object, watermarking and headers.
3. **Wording:** "based on", not "used".
4. **Diagnostics are kept**, in the popover's "Based on" section, for all users, as today's tooltips are.

## Acceptance criteria

- A project answer shows exactly one chip naming the project, and no "configured sources" badge.
- Project + web search shows one chip naming both, never "multiple sources" with the project hidden.
- A project in scope whose content was not used is never shown as a basis. It appears under "Not used".
- An unavailable project shows the amber chip; the basis chip reflects what was actually used.
- App-configured sources without a project still show; app sources + a project are each named once.
- A workflow answer shows the workflow chip; its popover links to the execution and keeps the AI generated section.
- An answer with provenance but no reported sources (aborted, or stored before sources existed) shows the chip as "AI-generated" with the popover's AI section only.
- Everything is reachable by keyboard and screen reader, with no information only in `title`.
- The row fits a 320px taskpane in German without horizontal scroll.
- EN and DE strings exist, plus a release note in `docs/releases/next/`.

## Files

- Server:
  - `server/services/PromptService.js`
  - `server/services/loop/seams/knowledgeSourceSeam.js`
  - `server/services/knowledge/KnowledgeScopePlanner.js`
  - `server/services/loop/contracts/sseV2.js`
  - `server/services/loop/contracts/runLogEvents.js`
- Client:
  - `client/src/features/chat/components/AnswerSourceBadge.jsx`, which becomes the basis chip and popover
  - `client/src/features/chat/components/ProvenanceInfo.jsx`, whose content becomes a popover section
  - `client/src/features/chat/components/ChatMessage.jsx`, the footer row
- Strings: `shared/i18n/en.json`, `shared/i18n/de.json` (`chatMessage.answerSource.*`, `chatMessage.knowledgeScope.*`, `chatMessage.provenance.*`)
