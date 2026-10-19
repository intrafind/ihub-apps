# Breaking Changes — Unreleased

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
