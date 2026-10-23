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

## "Skip to content" links now skip to the content

Pressing Enter on the skip link at the top of a page took keyboard and screen-reader users to the
start page instead of into the page's content. It now moves focus to the main content area on app
pages and on admin pages, and the page no longer changes. Admin pages also had two main-content
regions (and the Marketplace and Settings pages added more); each page now has exactly one, so a
screen reader's landmark list is no longer ambiguous.

## Secondary text and coloured buttons meet the 4.5:1 contrast ratio

Grey helper text, placeholders, "Retry" links and green or orange buttons with white text were
below the 4.5:1 contrast ratio for normal text, in light mode (grey text) and in dark mode (grey
text on dark panels). The text colours are darker or lighter as needed, fixed pixel text sizes
now follow the browser's text-size setting, and the red "yes/no" labels in the workflow editor are
easier to read.

## Screen readers announce unlabelled admin controls

The "Upload Config" buttons, the account on/off switch in the user list, the feature switches, and
the language fields of multilingual settings (including their "remove language" buttons) had no
accessible name, so a screen reader announced them as "button" or "edit text". They are now
labelled. The upload buttons also open the file picker from the keyboard; before, Tab landed on an
invisible file field instead.
Error messages on the admin pages (a list that could not be loaded, a failed save) now look and
behave the same everywhere: they are announced by screen readers, meet the contrast ratio, and the
dismissible ones have a labelled "Dismiss" button instead of an unlabelled icon.

## Prompt cards no longer contain buttons inside a button

Each card in the prompt library was one big button that also held the favourite, copy, details and
edit buttons, which screen readers handle unpredictably. The prompt's name is now the button that
opens it, stretched over the whole card, so clicking anywhere on the card still works.

## Scheduled tasks with memory now compare against what they reported before

A task that remembers between runs sometimes reported items again without checking its notes. Each
run is now told explicitly to compare the current state with the saved watermark (latest version or
date, item titles or ids) and the previous report, and to leave out everything already covered. You
no longer need to add this to the task's prompt.
