# Breaking Changes — Unreleased

## Temperature Is Set on the Model, Not on Apps, Agents or Workflows

iHub no longer sends a temperature of its own. Current models are tuned for specific sampling
settings, and a value picked per app often contradicts them: reasoning models get stuck repeating
themselves at low temperatures, and some providers fix the temperature or reject a custom one. A
request now carries a sampling parameter only when the model's configuration sets one. Otherwise the
provider's own default applies, which for vLLM is the model's `generation_config.json`, the values
its vendor recommends.

- The `preferredTemperature` setting of apps and agents, the memory composer temperature of agents,
  the temperature of workflow nodes and the app setting that showed the temperature slider are
  gone. The app editor, the agent editor, the workflow editor and the app creation wizard no longer
  offer them.
- The temperature slider is gone from the chat settings, and so is the `temp` URL parameter.
  Exported chats no longer list a temperature.
- The internal helper calls (chat titles, memory composing, OCR, summaries, the workflow verifier and
  query planner) no longer send one either.
- The OpenAI-compatible API (`/v1/chat/completions` and `/v1/responses`) still accepts
  `temperature` so that existing clients keep working, but ignores it.
- Admins who want a fixed sampling setting for a model set `sampling` on it, in the model editor or
  in `models/*.json`: `temperature` (0–2), `topP` (0–1) and `topK` (a whole number of 1 or more),
  each optional. It applies to every request to that model, from any app. Models that reject
  sampling parameters (`supportsTemperature: false`) ignore it. See [Models](../../models.md).

```json
{
  "id": "qwen3-6-35b",
  "sampling": { "temperature": 1.0, "topP": 0.95, "topK": 20 }
}
```

**Before upgrading:** Nothing has to be changed by hand. When the server starts, it removes the
removed settings from `contents/apps`, `contents/agents/profiles`, `contents/workflows` and
`contents/prompts` and logs each value it dropped. The values are not copied to the models: if an app
depended on a specific temperature, set `sampling` on the model it runs on. Apps, agents or workflows
that you import or install from elsewhere and that still contain `preferredTemperature` or a node
temperature are rejected by validation until the setting is removed from them.
