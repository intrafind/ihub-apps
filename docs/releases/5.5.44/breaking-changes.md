# Breaking Changes — 5.5.44

## Skills: Apps Must Enable Skills Explicitly

Skills are now opt-in per app. Before, personal skills reached every app that did not set
`skillSettings.allowPersonal: false`: one skill created by a user put an `<available_skills>` block
and the `activate_skill` / `read_skill_resource` tools into every app they used, including
tool-less apps such as Babelfish. In a test with a reasoning model, that was enough to make a
simple translation run until the token limit, and it leaked unrelated personal instructions into
apps their authors never planned for them.

An app now offers skills only when it sets `skillSettings.enabled: true`. Without it, neither
global nor personal skills reach the model, `requestedSkills` and `/name` do nothing, and skills
activated earlier in the chat are not carried over. `skillSettings.allowPersonal` stays, as a
switch that applies once skills are enabled. Agent nodes keep their own skill list and are not
affected.

The upgrade keeps existing setups working: it sets `skillSettings.enabled: true` on every app that
lists `skills` and on the general-purpose chat apps (`chat`, `web-chat`, `iassistant`), and logs
each decision. All other apps start with skills off.

**Before upgrading:** Apps you want to offer skills in, for example one that relied on users' own
skills, need **Enable skills in this app** under **Admin → Apps → Skills**, or
`"skillSettings": { "enabled": true }` in the app file. Apps you install from the marketplace need
the setting too, and config management that writes app files should set it.

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
