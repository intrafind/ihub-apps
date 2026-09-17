# Breaking Changes — 5.5.7

## Reasoning Effort Is a Level, Not a Token Budget

`thinking.budget` is removed from model, app and workflow-node configs, and `thinkingBudget` is
removed from the chat/inference API. Reasoning effort is `thinking.level` — `minimal`, `low`,
`medium` or `high` — everywhere.

The number never meant what it looked like it meant. No adapter ever put it on the wire: every one
bucketed it into one of those four levels first, and anything above 500 came out as `high`. A budget
of `1024` and a budget of `32768` were the same request. The app settings panel made it worse by
offering the number as a 0–32768 field labelled "Maximum tokens for thinking".

- A configuration migration runs automatically on upgrade. `V105` converts every stored
  `thinking.budget` — models, apps and workflow nodes — with the mapping the adapters already
  applied: `0`→`minimal`, `-1`→`medium`, `1-100`→`low`, `101-500`→`medium`, `>500`→`high`. A
  `thinking.level` you had already set is kept and the stale budget is dropped.
- **Apps gain a level they never had.** The app `thinking` block previously accepted only `enabled`,
  `budget` and `thoughts` — an app could not express a reasoning level at all, only spell one as a
  number.
- **The API field is gone.** A client sending `thinkingBudget` to the chat or inference endpoints now
  gets a validation error; send `thinkingLevel` instead, which is enum-constrained to the four
  levels. Chat settings saved in a browser with a budget lose that setting and fall back to the
  app's level.
- In the app settings panel, **Thinking Budget** is now **Reasoning Effort**, a four-way choice.
- Telemetry records `thinking.level` in place of the `thinking.budget` attribute.

**Before upgrading:** No action needed for stored configuration — the migration converts it. If you
have external clients calling the chat or inference API with `thinkingBudget`, switch them to
`thinkingLevel` before upgrading.

## Gemini Thinking Takes `thinking.level` Only

iHub now speaks a single Gemini `thinkingConfig` shape — Gemini 3's `thinkingLevel` plus
`includeThoughts`. The Gemini 2.5 `thinkingBudget` is no longer sent, and `thinking.budget` on a
`provider: "google"` model is rejected by the model schema instead of being silently ignored.

Gemini's two thinking schemas were never interchangeable: each returns a bare `400
INVALID_ARGUMENT`, naming no field, when handed the other's. Carrying both meant every Gemini model
config had to declare which generation it belonged to, and one left on the old shape broke the
moment Google moved a `-latest` alias forward — which is what migration `V089` already had to
repair once.

- A configuration migration runs automatically on upgrade. `V104` converts every
  `provider: "google"` model that still carries `thinking.budget`, mapping it onto the level the
  rest of the codebase already derived from a budget: `0`→`minimal`, `-1`→`medium`, `1-100`→`low`,
  `101-500`→`medium`, `>500`→`high`. A `thinking.level` you had already set is kept and the stale
  budget is dropped.
- **Every other provider is unaffected.** Anthropic still reads `thinking.budget` as
  `budget_tokens`, and the OpenAI Responses adapter still maps it to a reasoning effort. The
  rejection is scoped to Google.
- **Gemini 2.x models are retired.** A 2.x endpoint rejects the only `thinkingConfig` iHub now
  sends, so `V104` removes them, following the same rules `V089` used for retired models:
  - A model file still matching the Gemini 2.x example iHub shipped is **deleted**.
  - A model file you had edited is **disabled** instead, not deleted — it may point at your own
    Vertex or proxy endpoint, and its url, headers and per-model key exist nowhere else. The reason
    is written to the migration log. Re-enable it in **Admin → Models** if you still need it.
  - Either way the model leaves every selector, and apps are repointed onto the Gemini 3
    equivalent: `gemini-2.5-pro` → `gemini-3.1-pro`, `gemini-2.5-flash` and `gemini-2.0-flash` →
    `gemini-3.8-flash`, `gemini-2.5-flash-lite` → `gemini-3.5-flash-lite`,
    `gemini-2.5-flash-image` → `gemini-3.1-flash-image`. Both `preferredModel` and `allowedModels`
    are rewritten.
- The shipped Gemini 2.x example configs (`examples/models/gemini-2.0-flash.json`,
  `gemini-2.5-flash.json`, `gemini-2.5-flash-lite.json`, `gemini-2.5-pro.json`,
  `gemini-2.5-flash-image.json`) are removed.

**Before upgrading:** If you run a Gemini 2.x model, move the work to a Gemini 3 model. If one of
them is your **system-wide default**, no replacement is promoted automatically — the migration logs
a warning and you pick a new default in **Admin → Models**. No action is needed for Gemini 3.x
models.
