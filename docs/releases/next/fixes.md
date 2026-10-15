# Fixes — Unreleased

## Opening a Running Scheduled Run No Longer Risks Cancelling It

A scheduled run could end as "cancelled" after someone opened its chat while it was still
running and waited for it. The browser sent a stop request on its own — when it re-attached to the
run, replaced its connection, timed out or sent a follow-up — and that request ends a stored run.

- The browser no longer stops a chat turn by itself: only the Stop button (and "Clear chat", and
  the compare view's stop) does
- Leaving or reloading a chat leaves a stored run going; a chat that is not stored still ends
  when its connection closes
