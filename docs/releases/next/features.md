# Features — Unreleased

## Text Watermark: Detector Settings Are Optional and Explained

For a model marked **iHub watermark (vLLM)**, the detector settings in **Admin → Models → Output marking** are
now all optional, show their defaults, and say what they are for.

- **Detector URL** is optional. Without one the output is still watermarked; only Verify and the self-test cannot
  recognise the mark. The EU AI Act configuration check shows this as *Attention* instead of *Failing*.
- **Detector credential** is optional and picked from the bearer credentials instead of typed as an id. A detector
  on an internal network that asks for no token is called without one. A credential that is set but cannot be read
  still stops the call and shows as *Failing*.
- **Tokenizer** shows the model ID it falls back to, and **Watermark context** (formerly "Context width") shows its
  default of 4 and explains that it is vLLM's watermark `context_width`, not the model's context window.
- The fields no longer shift out of line when a label wraps.

## Container Image: Signed SBOM and Vulnerability Report

The container image on `ghcr.io/intrafind/ihub-apps` now carries Trivy's SBOM and Trivy's
vulnerability report as signed attestations, so you can check what an image contains and what was
known about it at release time without scanning it yourself.

- The CycloneDX SBOM can be imported into tools such as Dependency-Track.
- The vulnerability report lists Trivy's findings of every severity on the day the image was
  built, including waived findings marked as suppressed. CVEs published later are not in it.
- Both are verified and downloaded with `gh attestation verify --predicate-type …`; the commands
  are in the security documentation under "Verifying a Release".
- The image keeps its existing BuildKit SBOM and build provenance.

## Apps: Use All Integrations and All Skills

An app can now use every integration and every skill, including ones installed later, so a new
MCP server, catalog integration or skill reaches the app without editing it. Single integrations
can still be configured or left out.

- **Admin → Apps → Edit → Integrations → Use all integrations** (`"integrations": { "*": {} }`)
  binds every integration that gives the model tools: MCP servers, agents, catalog integrations,
  iFinder, the people directories, LDAP browsers and iHub's own tools (`ask_user`, scheduled
  tasks). Web search, storage providers and iAssistant keep their own panels and are not included.
- An integration the app also binds by itself keeps its own settings (actions, Required, scopes);
  **Exclude from "All integrations"** leaves one out (`"*": { "exclude": ["jira"] }`, also by
  definition id or `type:…`). "All integrations" never hides the app.
- **Admin → Apps → Edit → Skills → All skills** (`"skills": ["*"]`) offers every skill.
- The user's groups still decide which integrations and skills a user gets.

See [Apps → Integrations](../../apps.md#integrations-binding-an-installed-integration) and
[Skill Settings](../../apps.md#skill-settings).

## vLLM: Limit How Long a Reasoning Model Thinks

vLLM models can now cap their reasoning in tokens, so a model like Qwen3 no longer thinks
through its whole output limit and ends with an empty answer. Qwen ignores the reasoning effort
level; the token budget is enforced by vLLM itself.

- **Admin → Models → Edit → Reasoning → Limit reasoning in tokens** (`thinking.tokenBudget`)
  turns it on. Reasoning effort then sets the budget: Minimal 512, Low 2,048, Medium 8,192,
  High 16,384 tokens. When it is spent, the model stops thinking and writes the answer.
- **Reasoning budget** (`thinking.budgetTokens`) sets an exact number instead.
- The budget never takes more than 75% of the output limit, so the answer always has room.
- Off by default: the vLLM server must run with a reasoning parser that has start and end
  markers (such as `qwen3`) or with `--reasoning-config`, otherwise vLLM rejects the requests.
- When an answer still hits the output limit, the chat now says what happened instead of showing
  "Truncated": the model used the limit for thinking and wrote no answer (with **Retry**), or the
  answer is incomplete (ask it to continue).

See [Local LLM providers](../../local-llm-providers.md).
