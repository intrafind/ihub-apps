# Features — Unreleased

## Projects: Tier Policy Setting and iFinder Smart Collections Check

Full administrators can now choose where users find their projects under **Admin → Projects →
Project settings**: **iHub projects only** (the default), **iHub projects and iFinder smart
collections**, or **iFinder smart collections preferred**. The change applies at once, without a
restart; until now the tier policy could only be set in `platform.json`.

The iFinder integration test (**Admin → Integrations → iFinder → Test**) has a new step,
**iFinder smart collections**, that asks the Smart Collections API for the collections of the test
user and says why the tier would stay hidden:

- **Tier policy:** a warning when the policy hides the collections although the API works.
- **API and role:** an iFinder without the Smart Collections API (before 6.8) and a user without
  the `fi_smartcollections` role are named, with what to change. Both are warnings only while the
  policy hides the tier, so they do not turn an otherwise working test red.
- **Owner:** an empty list and a login with capital letters get a hint, because iFinder lists
  collections by exact owner name.
  
## Chat: Click a Cited Source Row to Open It in the Sources Panel

In the "Cited in this answer" list under an answer, only the number opened the sources panel. Now a
click anywhere on a row opens the panel on that source. The title link still opens the document,
and the row is still highlighted on hover.
