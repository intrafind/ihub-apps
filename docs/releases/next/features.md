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
The project page now has a chat field at the top: type a message and press Enter to start a chat in the project, with that message already sent.
Next to it you can choose another app for this chat; without a message the button opens an empty chat.
Each project has a **default app** (project page → **Settings**), which is where its new chats start.
The projects a chat draws on, and the project it runs in, now sit beside the message box instead of in a bar under the header: tick projects under **Projects for this chat** in the **+** menu.
A chat can no longer be moved into or out of a project once it exists (**Move to project** is gone from the chat page and the chat history): start the chat from the project page, or pick the projects before you send the first message.
Chats that already live in a project stay there.
