# Fixes — Unreleased

- **Voice mode no longer makes translation apps answer instead of translate.** The voice style instruction used to tell the model that the user was talking to it, which overrode apps whose messages are meant for someone else, such as Babelfish: saying "Wie heißen Sie?" returned "English" instead of "What is your name?". The instruction now only describes how the answer sounds and leaves the app's own role and instructions in force.
- **Voice transcription over `wss://` honors the SSL whitelist.** Connecting the microphone input to a realtime speech-to-text endpoint such as vLLM Voxtral over `wss://` failed with "unable to verify the first certificate" when the server used a private CA, even if its host was in `ssl.domainWhitelist`. Hosts on the whitelist (with `ssl.ignoreInvalidCertificates` enabled) now connect; all other hosts are still verified. The same whitelist now also applies to MCP servers over HTTP(S) and to Gemini batch transcription, which previously ignored it.
- **The OAuth client list no longer labels clients "Admin".** Clients that were neither dynamically registered nor personal — including clients identified by a metadata document such as Claude Code — showed a gray "Admin" badge, which read as if the connecting user had admin rights. The badge now says how the client was provisioned: **Static** (configured on the platform), **Personal**, **Dynamic** or **Client metadata**, with a tooltip stating that it is not a permission level. Metadata-document clients also show their display name and host on the row. The Connections tab uses the same labels, and the kind filter gained "Static" and "Client metadata".

## Projects: transferring ownership asks first and says what happened

Picking a new owner under **Transfer ownership** used to hand the project over at once, and
afterwards it could look as if nothing had happened: a project still shared with one of your groups
or with everyone stayed in your list. A second step now explains what the transfer means and asks
you to confirm.

- The confirmation says what the new owner may do, that you lose ownership, and which group or
  "everyone signed in" shares stay in force after the handover.
- Afterwards the Projects page names the new owner and says when you still see the project under
  **Shared with me** because a share reaches you.
