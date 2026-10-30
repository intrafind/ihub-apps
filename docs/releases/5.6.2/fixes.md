# Fixes — 5.6.2

## Chat: People Searches Are No Longer Shown as Web Searches

Answers from apps that search a people directory, such as the People Search app, said "Searched the
web · 1 search" above the answer, although the directory lookup never left the organisation. The
tool activity now lists a people search as a tool call ("1 tool call") instead.

## Voice Transcription, MCP Servers and Gemini Batch Transcription Honor the SSL Whitelist

Connecting the microphone to a realtime speech-to-text endpoint over `wss://`, such as vLLM
Voxtral, failed with "unable to verify the first certificate" when the endpoint used a certificate
from a private CA, even if its host was in `ssl.domainWhitelist`. Hosts on the whitelist (with
`ssl.ignoreInvalidCertificates` on) now connect; all other hosts are still verified. MCP servers
over HTTP(S) and Gemini batch transcription ignored the whitelist as well and now honor it too.

## Scheduled Tasks With Memory No Longer Repeat What They Reported Before

A task that remembers between runs sometimes reported the same items again. Each run is now told to
compare the current state with what it noted last time (latest version or date, titles or ids) and
with its previous report, and to leave out what was already covered. You no longer need to write
this into the task's prompt.

## The OAuth Client List No Longer Labels Clients "Admin"

Clients that were neither dynamically registered nor personal, including clients identified by a
metadata document such as Claude Code, showed an "Admin" badge, which read as if the connecting
user had admin rights. The badge now says how the client was set up: **Static**, **Personal**,
**Dynamic** or **Client metadata**, with a tooltip explaining that it is not a permission level.
Metadata-document clients also show their display name and host. The Connections tab uses the same
labels, and the filter gained **Static** and **Client metadata**.

## The Admin Usage Page Lists the Busiest Entries First

Apps, token usage per app, magic prompt apps and users, and the model details are now sorted from
highest to lowest instead of in the order they were first recorded. Models are sorted by total
tokens.

## Admin Sidebar Entries Are Sorted Alphabetically

The entries inside each section of the admin navigation (for example AI Workspace, Observability or
Platform) are now ordered A–Z by their displayed name, in the language you use.

## Accessibility Improvements

- **"Skip to content" works:** the skip link at the top of a page took keyboard and screen-reader
  users to the start page. It now moves focus to the main content on app and admin pages. Each
  admin page now has exactly one main region, so a screen reader's landmark list is no longer
  ambiguous.
- **Better contrast:** grey helper text, placeholders, "Retry" links and green or orange buttons
  with white text now meet the 4.5:1 contrast ratio in light and dark mode. Fixed pixel font sizes
  now follow the browser's text size setting, and the red "yes/no" labels in the workflow editor are
  easier to read.
- **Labelled admin controls:** the **Upload Config** buttons, the account switch in the user list,
  the feature switches and the language fields of multilingual settings (with their "remove
  language" buttons) are now announced with a name instead of just "button" or "edit text". The
  upload buttons now open the file picker from the keyboard.
- **Consistent error messages** on the admin pages: they are announced by screen readers, meet the
  contrast ratio, and dismissible ones have a labelled **Dismiss** button.
- **Prompt library cards** no longer contain buttons inside a button, which screen readers handled
  unpredictably. Clicking anywhere on a card still opens the prompt.

## Gemini Web Search Sources Show the Real Pages

The sources panel listed Google's native web search results only by generic names such as
"google.dev", because Gemini returns its sources as redirect links. These are now resolved to the
actual page addresses, so each source shows its real site and opens the page directly. Opening a
source link in a browser also no longer shows a false "The link could not be opened" message after
the page opened.

## Stricter Hostname Check for Outbound Requests

Node.js 24.22.1 fixes a flaw where a hostname containing a NUL byte was checked as one host but
looked up as another. The built-in protection against requests to internal addresses now also
rejects hostnames with control characters. Rebuild the Docker image without cache to get the patched
Node.js runtime.

## Outlook `.msg` Files Can Be Uploaded Again

Selecting an Outlook message (`.msg`) in a chat failed, and the browser console showed:

> Error processing file: TypeError: Cannot read properties of undefined (reading 'prototype')

The library that reads `.msg` files needs a component the web app did not ship. It is now included,
so the subject, sender, recipients and body of the message reach the model again.

## Updates: Windows Installations and Multi-Worker Servers Update Reliably

The in-place update could not work on Windows — it looked for a `-windows.tar.gz` archive that is
never published (Windows releases are `-win.zip`), and a running Windows server cannot rename its
own folders. On every platform with the default four workers, *Update Now* restarted only one
worker, leaving the others on the old version while the page reported success. The published
checksum was also never checked, because releases did not include `checksums.sha256`.

- Windows updates use the `.zip` release and are applied by the launcher before the server starts,
  also under the Windows service.
- An update now restarts the whole server, and the Updates page waits for the new version to be up.
- Releases publish a signed `checksums.sha256`, and a mismatch stops the update.
