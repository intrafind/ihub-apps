# Breaking Changes — Unreleased

## Playwright and Selenium Screenshot Tools Removed

The `playwrightScreenshot` and `seleniumScreenshot` tools are no longer shipped. No default app
used them, and they could not run on a default installation: Playwright needs a separately
installed browser and Selenium a Chrome driver, which the product never provided.

- The upgrade deletes the two tool files from `contents/tools/`. Apps that still list either tool
  keep working; the missing tool is skipped.
- The `playwright` and `selenium-webdriver` packages are no longer installed with the server.

**Before upgrading:** If an app of yours relies on one of these tools, keep a copy of its tool file
and script from the previous release before upgrading.

## A Model's `supportsTools` Is Now `none`, `auto` or `required`

`supportsTools` on a model was a yes/no flag. It is now a three-state setting, so a model can also say
whether the provider accepts a forced tool call (which an app's `toolChoice: "required"` needs). In
the model editor it is the **Tool Calling** dropdown:

| Value | Meaning |
|-------|---------|
| `none` | No tools (was `false`) |
| `auto` | Tools; the model decides whether to call one |
| `required` | Tools, and the provider accepts a forced tool call |

- The upgrade converts every model file: `false` becomes `none`; `true` becomes `required` for
  models on the OpenAI and Azure OpenAI APIs, Mistral's API, Google chat models and Bedrock's
  Claude and Nova models, and `auto` for everything else: Anthropic, vLLM and other local servers
  (`provider: "local"`, and `openai` models with your own URL rather than OpenAI's or Azure's),
  whose support depends on the installation, and other Bedrock models. Raise a model to `required`
  in the editor when its provider accepts a forced tool choice.
- An app's `settings.model.filter` is converted too: `{ "supportsTools": true }` becomes
  `{ "supportsTools": ["auto", "required"] }` (a filter value that is an array matches any of its
  entries) and `false` becomes `"none"`.
- A boolean `supportsTools` is no longer accepted: model files saved through the admin API, scripts
  and provisioning that still send `true` or `false` are rejected and need the new values.

**Before upgrading:** If you generate model files outside iHub (provisioning, scripts, an
infrastructure repository), switch them to `none`, `auto` or `required`.
