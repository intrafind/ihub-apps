# EU AI Act (Article 50)

How iHub Apps helps an operator meet the transparency duties of Art. 50 of the EU AI Act. This page is
the landing page for the measures; it is not legal advice.

| Duty | What iHub does | What the operator does |
| --- | --- | --- |
| Art. 50(1): people know they are dealing with an AI | The assistant always says it is an AI when asked and never claims to be human, even in a role. A notice in the empty chat says so before the first message. | Review the notice text; keep it on unless an app is clearly not a chat. |

Marking of generated content (Art. 50(2)) is covered by later features and added to this page.

## Guardrail prompt (always on)

Every call to a text model carries this rule as the last text of the system prompt:

> You are an AI system. If asked, always say so. Never claim to be human, even in a role.

- **All channels.** It is added in `LLMClient.execute`, the one place every model call passes through, so
  chat, the inference API (`/api/inference/v1/*`), MCP, A2A, agents, workflows and scheduled tasks all
  get it. See [LLM Client](llm-client.md#ai-disclosure-guardrail).
- **Wording is global, the rule is not optional.** An admin can reword it for the whole platform in
  `aiDisclosure.guardrail.text` (`platform.json`) or **Admin → Advanced → AI notice**; empty uses the
  built-in text above (up to 2000 characters). There is no setting, request field or environment variable that
  switches it off, and no per-app wording. An app prompt or a client-supplied `system` message cannot remove it:
  the rule is appended after them. A reworded rule still has to say that the assistant is an AI and never
  claims to be human; iHub does not check that.
- **iAssistant.** The `iassistant-conversation` provider does not use iHub's system message (its adapter
  sends only the last user message), so the rule does not reach it that way; iAssistant handles its own
  disclosure.
- **A reduction, not a guarantee.** A model can still ignore a prompt rule in a strong role-play. Check
  the models you use with the question "Are you a human?".

## First-turn notice

A short text in the empty chat, above the message box: *You are chatting with an AI system, not a person.
Answers can be wrong, so please check important information.*

- It is interface only: never a message, never sent to the model, never stored. A stored chat with
  messages does not show it; an empty chat shows it again.
- **Platform:** `aiDisclosure.firstTurnNotice` in `platform.json`, or **Admin → Advanced → AI notice**.
  `enabled: false` hides it in every app. `text` is `{ "en": "…", "de": "…" }`; an empty map uses the
  built-in text in the user's language. Inline Markdown (links) is allowed.
- **Per app:** `aiDisclosure.firstTurnNotice` in the app, or the *AI notice* section of the app editor:
  use the platform notice (no key), a custom `text`, or `enabled: false` for this app. The platform switch
  wins: an app cannot turn the notice on when the platform has it off.
- **Shown in:** the app chat (also above a start form). Not shown for apps that start by themselves
  (`autoStart`), in the Office add-in panel, in compare mode or for `iframe` and `redirect` apps; the guardrail applies to
  all model calls regardless.

```json
{ "aiDisclosure": { "firstTurnNotice": { "enabled": true, "text": { "en": "You are talking to an AI." } } } }
```
