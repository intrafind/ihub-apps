# Voice Mode: Inline Dock Redesign

Follow-up to [2026-10-17 Voice Mode](2026-10-17%20Voice%20Mode.md). It replaces that concept's
**voice view** (`VoiceModeOverlay`, a full-cover overlay over the messages and the composer) with
a dock in the composer's place. Everything else in that concept (turn loop, speech services,
gating, privacy) is unchanged.

## Why

A UX research review and a UI design review of the shipped overlay, compared against claude.ai's
voice mode, found the same core problem: the overlay hid the conversation that voice mode is
supposed to be part of.

| Finding | Severity |
| --- | --- |
| Earlier turns, sources, links and clarification options are hidden behind the overlay (`bg-white/95 backdrop-blur`); the blurred bubbles read as a rendering glitch | Critical |
| The answer is shown again as centred, unformatted text in a 5-line scroll box with a visible scrollbar | High |
| Two exits (✕ at the top right, red **End** at the bottom), "Chat" shown twice (page header and overlay header) | High |
| The 144 px orb is the loudest element and uses five colours nobody learns; the content is small | Medium |
| Interrupting is only possible by clicking the orb, and nothing shows that it is clickable | Medium |
| "Mute" stops the microphone and the playback, but has no mic-slash icon | Medium |
| The settings gear sits in the top corner, far from every other control | Low |

## What changed

- **The message list stays live and usable.** Turns land in it as normal messages. It is no
  longer `inert`; only message editing is switched off while voice mode is on (an edit starts a
  typed run voice mode knows nothing about).
- **`VoiceModeDock` takes the composer's place.** The composers stay mounted but `hidden` and
  `inert`, so drafts and attachments survive. AppChat mounts both a phone and a desktop layout;
  the dock renders once, in the layout `useMediaQuery('(min-width: 48rem)')` says is shown,
  because its Esc/Space listeners are on the window.
  - Row 1: the status (placeholder style) or, while the user speaks, the interim transcript
    (`aria-hidden`; the status line stays the one live region). Errors show here with **Try
    again**.
  - Row 2: settings (popover opens upwards), **Stop** (thinking and speaking only; replaces the
    orb tap), mute (mic-slash icon when muted), **Hold to talk** (push-to-talk), and one **End**
    pill in the state's colour that carries the level bars. It is not red, because ending keeps
    the conversation.
  - Under the dock: the shortcuts (keyboard devices only) or the notice line.
  - A radial glow above the dock in the state's colour, driven by `--voice-level`.
- **Read-along in the message itself.** `spokenChars` counts characters of the speech text
  (markdown source). `utils/readAlong.js` matches it to the rendered message by counting letters
  and digits in both, and marks the rest with a CSS Custom Highlight
  (`::highlight(voice-unspoken)`), so React's DOM is never touched. A `MutationObserver` keeps
  the mark on the streaming message. The chat scrolls to keep the spot in view, except within
  4 s of the user's own scroll. Browsers without the API show no mark.
- **Esc and Space respect the chat's own dialogs**, since the chat is reachable now.
- **The "Show captions" setting is now "Show live transcript"** (same pref key). It controls the
  dock transcript and the read-along mark.
- **Admin "Try it"** renders a small chat with the dock under it.
- **Typing while voice mode is on** (decided after the first version, like Claude). The dock's
  first row is a text field bound to the composer's draft; its placeholder is the state or the
  live transcript. Enter or Send calls `voiceMode.sendText`: it stops a running answer
  (`bargeIn(true)`), waits for the cancelled run to end, and sends the text as a voice turn with
  `{ typed: true }`. The answer is spoken (text only while muted), and the message is not marked
  as spoken. A transcript that arrives while a typed message goes out starts no second turn.

## Kept from the overlay

Space push-to-talk (not in fields, on buttons or in dialogs), Enter on the hold button, the
screen-reader latch, pointer capture, blur ends the hold, focus taken on open and returned on
close, focus on **Try again** after an error, a stable `role="status"` and a separate
`role="alert"`, an always-mounted notice line, and reduced motion. State is shown in words and
colour as well as motion.

## Open questions

- An inline "jump to live" pill when the user has scrolled up.
- Moderated test with 5–6 users (laptop speakers and phone): ask, interrupt, mute, find
  push-to-talk, recover from an error.
