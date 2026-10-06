# Features — Unreleased

## Skills: Skills Stay Active for the Whole Chat

A skill now stays active for the rest of the chat once it is loaded, whether the user named it with
`/name` or the model chose it. Follow-up messages are answered with its instructions without naming
it again, so interview skills such as **skill-builder** keep asking their questions instead of
forgetting them after the first answer.

- Access is checked again on every turn: a skill whose grant, app assignment or share is removed
  is no longer active. At most `skillSettings.maxActiveSkills` (default 3) skills are active at
  once, the ones named in the current message first, then the most recently activated ones.
- `skills.maxSkillBodyTokens` in `platform.json` now applies: an active skill with longer
  instructions stays active by its description, and the model reads the instructions when it needs
  them. All active skills together take at most a quarter of the model's context window.
- New `skills.maxCatalogTokens` (default 3000) caps the list of skills the model is offered in
  every message. Apps with many skills get shortened descriptions, then names only, and the model
  searches the skills with a new **Find Skill** tool. Existing installations get the setting on
  upgrade.
- A global skill whose `SKILL.md` sets `disable-model-invocation: true` is started only by users
  with `/name`: the model is not offered it and agents do not use it.

## Library: Tidier Search and Filter Bar

The top of the library (`/prompts`) is cleaner: search, sort and the "New" button line up at the
same height, and all filters sit together in one row instead of stacked lanes.

- Type (All, Prompts, Skills) and scope (All, Mine, Shared with me, Global, Favorites) are matching
  segmented controls side by side.
- Prompt categories are a "Category" dropdown in the same row; the selected category shows its
  configured color as a dot. The dropdown always offers "All categories", so
  `promptsList.categories.showAll` no longer has an effect on the library.
- On phones, sort and "New" share a row and the filters wrap instead of scrolling out of view.
