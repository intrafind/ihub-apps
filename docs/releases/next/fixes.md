# Fixes — Unreleased

## Gemini Live Transcription No Longer Stops After a Few Words

Transcribing an uploaded audio or video file with Gemini 3.5 Transcribe Live returned a few words
and then stopped without an error: Google ends a session that receives audio much faster than real
time. Files are now fed to Gemini Live at up to three times real time, sessions continue
seamlessly past Google's ten-minute limit, and a session the transcription service ends with an
error is reported to the user instead of passing as a complete transcript.

- Both limits can be tuned per model in its `config` (`maxRealtimeFactor`, `maxSessionSeconds`).
