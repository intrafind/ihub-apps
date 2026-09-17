# Fixes — 5.4.24

## The Footer No Longer Covers Content on Small Screens

The footer sat in a fixed band at the bottom of the viewport and stayed there while the page
scrolled behind it, cutting off the bottom of every page longer than the screen. On a phone, where
the copyright line and the footer links stack into two rows, it took away roughly a seventh of the
screen for the whole visit. The footer now comes after the content: it is off-screen until you
scroll to the end of the page, and pages shorter than the viewport still show it along the bottom
edge.

- Applies to the apps list, the prompts library, the workflows page and all custom pages — every
  view that shows the footer. App and admin views are unchanged.
- Pages now scroll as a document rather than inside the content area, which also makes the header
  stay put while scrolling instead of only appearing to.

## Gemini Models Failed With a Bare `400` After Google Moved the `-latest` Aliases

Every shipped Gemini model configuration still carried the Gemini 2.5 thinking settings
(`thinking.budget` / `thinking.thoughts`). Google's Gemini 3 endpoints reject those fields with a
bare `400 INVALID_ARGUMENT` that names no field, so once Google hot-swapped `gemini-flash-latest`
— the default model for a fresh installation — to a Gemini 3 release, chat requests started
failing with an error that gave no clue what was wrong.

All shipped Gemini configurations now use the Gemini 3 `thinking.level` setting, and existing
installations are migrated on upgrade. A thinking level you set yourself is left untouched.

## Anthropic Web Search No Longer Truncates Long Searches or Fails the Answer When Unavailable

Two failure modes of native web search on Claude models are now handled.

- When Anthropic pauses a long search turn (`stop_reason: pause_turn`), the answer used to end
  where the pause happened. The paused turn is now continued automatically on a follow-up request
  (up to three times per call), so the user gets the complete answer.
- When the provider rejects native web search — web search disabled for the organisation in the
  Claude Console, a model or gateway that does not support the tool — the whole chat request used
  to fail. The call is now retried with Brave Search instead, and the model is remembered as unable
  to search natively for 15 minutes so later answers skip the failing request.
- No configuration changes are required.

## Thinking Steps No Longer Drift Down While an Answer Streams

The "Show thinking"/"Hide thinking" toggle for models with extended thinking was rendered below
the answer text, so each streamed chunk of the answer pushed it further down the message —
readers watching a long response come in had to keep scrolling to find it. The toggle is now
anchored above the answer and stays in the same place for the whole response.

## Context Token Counter Reflects the Whole Conversation

The `~x / y context tokens` line above the chat input only counted the message
being typed, so a long multiturn conversation still read as a few hundred tokens
right up to the point where the model rejected the request as too large. Everything
already in the chat is re-sent on every turn, but none of it was counted.

- The estimate now covers the app's system prompt, the full chat history including
  the text of attached documents, and the pending message — the whole prompt going
  out with the next turn.
- Turning **Send chat history** off drops the history from the estimate, matching
  what is actually sent.
- The counter appears as soon as a conversation exists, not only while typing, and
  turns amber above 85% of the window and red once the window is exhausted.

Sources and tool definitions are resolved on the server and are still not part of
the estimate, so it remains a lower bound; the provider's own count after each turn
stays authoritative.

## The Model Selector Fits the Screen on Phones

Opening the model list on a phone showed a panel that ran off the right edge of
the screen, so model names and descriptions were cut off mid-word, and the rows
sat at visibly uneven distances from one another.

The list was a fixed 20 rem panel pinned to the left edge of its button, which
sits at the right end of the chat toolbar — on a narrow screen there was no room
left for it. Row heights came out uneven because a description that fitted on one
line made a shorter row than one that wrapped onto two.

- On phones the model list now opens as a full-width sheet from the bottom of the
  screen, with the rest of the page dimmed behind it. Tapping outside the sheet
  closes it.
- Every row is the same height, so the list reads as an even column instead of
  randomly spaced blocks.
- On tablets and desktops the list is unchanged: it still opens as a panel next
  to the model button, with the fuller two-line descriptions.
