# Features — Unreleased

**The shipped `config.env` of the binary distribution is slimmed down.** 
It now lists only the process settings (`PORT`, `HOST`, `WORKERS`, HTTPS certificates, `NODE_EXTRA_CA_CERTS`, `CONTENTS_DIR`). 
The LLM and web-search API keys, search endpoint overrides and the never-supported `GOOGLE_SEARCH_*` entries are gone: 
add providers and keys in the setup wizard or under **Admin → Providers**, where they are stored encrypted. 
Existing installations keep their own `config.env`, and keys already set as environment variables keep working.

**iHub now trusts the server's own certificate store.**
A company CA that is installed on the machine (Linux CA store, Windows or macOS certificate store) is trusted for every outbound TLS connection,
such as LLM endpoints, MCP servers and `wss://` voice transcription, in addition to Node's built-in roots.
Nothing needs to be configured, and the Docker image, binaries and `npm start` all behave the same. Set `NODE_USE_SYSTEM_CA=0` to turn it off. 
This needs Node 24.5 or later; on older runtimes set `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` instead.

**Projects are easier to use: start a chat from the project, and pick the projects of a chat in the "+" menu.**
The project page now has the same chat input as the start page at the top, with attachments, the model selector, tools, web search and magic prompt:
send a message to start a chat in the project, with that message already sent.
Above it you can choose another app for this chat; **New chat** opens an empty one.
Each project has a **default app**, which is where its new chats start.
The side panel of the project page is now a compact list (instructions, default app, members, catalog); **Edit** and **Change** open the settings in a dialog.
The projects a chat draws on, and the project it runs in, now sit beside the message box instead of in a bar under the header: tick projects under **Projects for this chat** in the **+** menu.

## Projects: link documents from other projects

A project can now use documents of another project without copying them. **Add documents → From
another project** lists your own projects and published ones (catalog projects, and admin projects
an administrator published, such as the shipped iHub documentation); tick documents and link them.

- Administrators publish an admin project with **Published** under **Admin → Projects → Edit**:
  everyone signed in can then use it and link its documents. The iHub documentation project is
  published by default, also on upgraded installations.

- Chats read the original as it is now, so a change there shows in every project that links it.
  A link counts as one item and takes no storage.
- Everyone reads a linked document with their own rights: a member who may not use the source
  project sees **No access** for it and the chat does not get its text.
- A removed original shows **Source removed**.

## Projects: global projects and the project catalog

Users can now make a project available to everyone: a few people curate it, everyone else uses it.
Admins choose which ways are open under **Admin → Projects → Sharing of user projects** (specific
users, groups, everyone signed in, the catalog); until now the "everyone" option could only be set
in `platform.json`.

- **Publish to the catalog** on a project page puts it in the catalog. Users find it under
  **Projects → Browse catalog** and add it to their projects. They use its documents by attaching it
  to their own chats; their chats and the members' chats stay apart.
- Projects shared with everyone show **Global**, published ones **Published**, and projects taken
  from the catalog **From the catalog**.
- The catalog is off by default (`platform.projects.sharing.allowCatalog`). Turning it off, or
  taking a project out, removes it from the lists of those who added it.

## Apps: switch projects off per app

**Admin → Apps → Edit → Projects** now has two switches, both on by default:

- **Use projects in this app**: when off, the app uses no project at all, neither its linked admin
  projects nor chats started in a project or projects attached in the chat.
- **Allow personal projects**: when off, the app keeps its admin projects but takes no user
  projects (`features.userProjects: false`, which could so far only be set in the app's JSON).

## Admin Projects: the items come first

The view and edit pages of an admin project now share the layout of a user's project page: the
items in the wide column, the settings beside them (compact rows on the view page, a compact form
on the edit page), so the documents are no longer pushed below a long form. The results of
**Test** and **Estimate tokens** appear above the items.
