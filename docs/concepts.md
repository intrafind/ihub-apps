# Core Concepts: Providers, Models, Apps, Skills, Sources & Tools

This guide explains the building blocks of iHub Apps and, more importantly, **when to use which**. It is the write-up we use when introducing iHub to a new team: once these boundaries are clear, designing use cases for a department and rolling them out to the right people becomes straightforward.

## The mental model

| Building block     | Answers the question                                  | Configured in                    |
| ------------------ | ----------------------------------------------------- | -------------------------------- |
| **Provider**       | How does iHub reach a model or external service?      | Admin → Providers                |
| **Model**          | Which model answers, with which limits and abilities? | Admin → Models                   |
| **App**            | What is the concrete use case and its frame?          | Admin → Apps                     |
| **Skill**          | Which reusable procedure, rules, or know-how apply?   | Admin → Skills                   |
| **Source**         | What domain knowledge does the model need?            | Admin → Sources                  |
| **Tool**           | What can the model *do* beyond producing text?        | Admin → Tools / MCP servers      |
| **Prompt library** | Which reusable text can a user drop into a chat?      | Admin → Prompts                  |
| **Group**          | Who sees all of the above?                            | Admin → Groups                   |

The short version:

- **Apps** model the concrete use case and its frame.
- **Skills** define reusable procedures, rules, and behaviour.
- **Sources** supply the factual context and knowledge.
- **Tools** give the model the ability to act and to fetch live data.

---

## Providers and models

**Providers** are the technical connection to an external or local service. A provider holds the endpoint and the credentials — API keys are administered centrally and [stored encrypted at rest](encryption-key-management.md). Out of the box iHub ships providers for OpenAI, Anthropic, Google, Mistral, and local/OpenAI-compatible servers, plus service providers such as iFinder.

**Models** are the entries users and apps actually select — GPT, Claude, Gemini, Mistral, or a locally hosted model. Each model carries its own configuration: context window, maximum output tokens, and capability flags such as tool calling and image support. See [Models](models.md).

### Separate models by use case

It pays to deliberately split models across use cases instead of routing everything through one:

- Internal or sensitive use cases run on a local model ([LM Studio, Jan.ai, vLLM](local-llm-providers.md)) or a dedicated, contractually covered endpoint.
- Public or low-risk scenarios can use a cloud model where quality or speed matters more.

### Control what users may choose

Model selection can be narrowed or fully predetermined:

| Setting                   | Effect                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `preferredModel`          | The model an app starts with                               |
| `allowedModels`           | Restricts the selectable models for that app               |
| `disallowModelSelection`  | Hides the model selector entirely — the app decides        |
| Group `models` permission | Restricts which models a user group may use at all         |

---

## Apps, prompt library, and skills — when to use which

These three overlap in what they can achieve, and the difference is mostly about **how much of the use case is fixed**.

### Apps

An [app](apps.md) is a standardized use case with a fixed frame: system prompt, input variables, output format, preferred/allowed models, plus the tools and sources it may use. Use apps when the result should be reproducible and the user should not have to know anything about prompting.

Apps are the unit of rollout: via group permissions — including groups mapped from [LDAP](ldap-ntlm-authentication.md) or [OIDC](oidc-authentication.md) — an app can be made available to exactly one department or role.

An existing app is portable. Download it as JSON from the app editor and re-create it on another installation by pasting the JSON into the editor's raw JSON view.

### Prompt library

The [prompt library](prompts.md) offers the opposite trade-off: maximum flexibility inside the general chat. A prompt is a reusable piece of text the user inserts into the input field and then edits freely.

The trade-off is discoverability — beyond a few dozen entries, a flat prompt library becomes hard to navigate. Mitigate that with categories and by scoping prompts to a single app (`appId`), or promote a frequently used prompt into a proper app.

### Skills

A [skill](architecture.md#skills-system) is a modular, reusable instruction package: a `SKILL.md` with metadata and instructions, plus optional reference documents, scripts, and assets. Skills are assigned to apps, permission-controlled per group, and can declare which tools they are allowed to use.

Skills are the right tool for **complex, multi-step procedures and rules that are reused in more than one place**. Instead of growing a single app prompt until nobody dares to touch it, cut the workflow into skills.

Example — a story or article generator: model the interview, the structuring, and the actual drafting as separate skills, and let the app compose them. Each step stays readable, testable, and reusable in other apps.

### Decision guide

| Situation                                                          | Use                |
| ------------------------------------------------------------------ | ------------------ |
| Recurring use case, fixed frame, should just work for everyone     | **App**            |
| Ad-hoc support in general chat, user wants to edit before sending  | **Prompt library** |
| Multi-step procedure, or rules reused across several apps          | **Skill**          |
| Needs to be visible only to one department                         | **App** + group    |

---

## Sources: giving the model knowledge

[Sources](sources.md) supply the domain context. Supported types include local files, URLs, iFinder documents, and internal iHub pages.

### Local files vs. URLs

| Source type    | Best for                                          | Trade-off                                                       |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| **Local file** | Curated content — Markdown, text, PDF, JSON       | Controlled, predictable context, but must be updated by hand    |
| **URL**        | Content that changes regularly                    | Always current, but page boilerplate can add noise to the context |

For URL sources, enable content cleaning and set a `maxContentLength` so navigation, footers, and cookie banners do not consume context that should hold the actual answer.

### iFinder as a source

Documents from [iFinder](iFinder-Integration.md) can be used directly as a source — pinned to a specific document ID or driven by a search query that loads the top matching documents. The connection is configured once centrally; documents are always fetched with the identity of the current user, so users only ever see what they are allowed to see.

### Loaded up front or fetched on demand

Each source is exposed either as a **prompt source** (its content is interpolated into the system prompt for every request) or as a **tool source** (the model fetches it only when it needs to). Prompt sources guarantee the content is present; tool sources keep the context small and scale to many sources.

### A note on wikis and linked content

When wiring up an internal wiki, point at concrete pages or at prepared, condensed content. Do not assume the model will navigate deep chains of links on its own — the more specific the source, the better the answer.

---

## Tools: letting the model act

[Tools](tool-calling.md) extend iHub beyond text generation: [web search and content extraction](web-tools.md), API calls, screenshots, people search, [Jira](JIRA_INTEGRATION.md), iFinder, and further systems connected via [MCP](mcp-integration.md). Tools are enabled per app, and the model calls them when the task requires it.

Note that tool calling requires a model that supports it — check the model's `supportsTools` flag.

---

## Integrations and data flow

- **Authentication**: [LDAP](ldap-ntlm-authentication.md), [OIDC/SSO](oidc-authentication.md), local accounts, proxy headers, or anonymous access — combinable. External groups are mapped onto iHub groups, which is what makes group-based app rollout work. See [Authentication Architecture](authentication-architecture.md).
- **Outlook add-in**: can be distributed centrally by IT and made available group-based. See [Outlook Add-in Rollout](outlook-add-in.md).
- **Speech-to-text**: which service transcribes matters. Browser-based speech recognition can send audio to the browser vendor's cloud. For sensitive environments, use the [self-hosted realtime transcription stack](voice-transcription.md), where audio is relayed by the iHub server to your own GPU host and nothing is persisted.
- **MCP servers and cloud models**: as with any external endpoint, check whether data leaves your own infrastructure before enabling them.

---

## Further capabilities

| Capability                                   | Notes                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Vision / image understanding**             | Depends on the model. It must support images (`supportsImages`) and be configured accordingly. See [Image Upload](image-upload-feature.md). |
| **[Magic Prompt](magic-prompt-feature.md)**  | Rewrites a short or incomplete user input into a better prompt, with an undo option.                               |
| **[Compare Mode](compare-mode.md)**          | Sends one input to two models and shows the answers side by side — useful for evaluating models against each other. |
| **Chat history**                             | Users can keep a conversation across reloads. There is no persistent memory spanning different conversations in chat apps — keeping chat history and long-term memory are separate things. Long-term memory exists only for agents in the [Agent Factory](agents.md). |
| **[Structured output](structured-output.md)**| JSON-schema-validated responses for apps whose output feeds another system.                                        |

---

## Related documentation

- [App Configuration](apps.md)
- [Models](models.md)
- [Sources System](sources.md)
- [Tool Calling](tool-calling.md)
- [Prompts Library](prompts.md)
- [Architecture Overview](architecture.md)
- [Admin UI Guide](admin-ui.md)
- [User Guide](user-guide.md)
