# Breaking Changes — 5.6.4

## Projects: Smart Collections Are Added From the Catalog, With Their Own App and Instructions

iFinder smart collections are no longer listed under **Projects** automatically. Users add the
ones they want from **Browse catalog**, which now lists **Your iFinder smart collections**. An added
collection becomes a project that keeps what iFinder does not have: a **default app**,
**instructions** and the **chats** started in it. Its documents stay in iFinder and are read with
the user's own rights, as before.

- Chats started on the page of a collection now run inside its project, so its instructions apply.
- **Rename** renames the collection in iFinder too.
- **Delete project** asks whether to delete the collection in iFinder as well; otherwise it stays in
  iFinder and can be added again.
- A collection deleted in iFinder keeps its project, marked **Deleted in iFinder**, with its chats
  and settings.
- **New project → As an iFinder smart collection** now takes instructions and a default app too.
- The **Browse catalog** button appears whenever smart collections are offered, even with the
  project catalog switched off.

**Before upgrading:** nothing to configure. Tell users of the iFinder tier (`tierPolicy` `both` or
`ifinder`) that their collections disappear from **Projects** until they add them from **Browse
catalog**. Chats that already have a collection attached keep it.
