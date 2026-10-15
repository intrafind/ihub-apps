# Fixes — Unreleased

## Opening a Running Scheduled Run No Longer Risks Cancelling It

A scheduled run could end as "cancelled" after someone opened its chat while it was still
running and waited for it. The browser sent a stop request on its own — when it re-attached to the
run, replaced its connection, timed out or sent a follow-up — and that request ends a stored run.

- The browser no longer stops a chat turn by itself: only the Stop button (and "Clear chat", and
  the compare view's stop) does
- Leaving or reloading a chat leaves a stored run going; a chat that is not stored still ends
  when its connection closes

## Audio Attachments Reach vLLM Models That Support Audio

Audio attached to a chat with a vLLM model that has **Supports Audio** enabled was silently
dropped: the model only saw the text of the message. vLLM models now receive the audio the same
way OpenAI models do. Models without the flag are unaffected.
