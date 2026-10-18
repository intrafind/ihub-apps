# Fixes — Unreleased

## Sidebar User Menu: "Sign Out" No Longer Jumps Sideways

Opening the user menu in the sidebar made the "Sign Out" entry start in the middle of its row and
then slide to the left. The entry's icon pointed at a file that does not exist, so a broken image
briefly took up space before it was removed. The menu now shows the correct sign-out icon and the
label stays in place.

## Voice Mode and Dictation With Gemini Live No Longer Repeat the Transcribed Text

While someone was speaking, the live caption in voice mode showed the same words several times in a
row ("Warum schreibenWarum schreiben wirWarum schreiben wir eigentlich alles"). Gemini Live sends a
revised guess for the whole sentence with every update, and the text was added up instead of being
replaced. The caption now shows the sentence once and grows with it.

- The same repetition in dictation and live transcription with Gemini Live is gone.
- A turn that ended without a finished transcript is no longer sent to the app as the stacked
  guesses.
- Other transcription models are not affected; their updates were already incremental.
