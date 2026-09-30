# Features — Unreleased

## Voice Input: Platform-Wide Defaults

Admins can now choose the dictation service and the transcription model once, under
**Admin → Voice Input → Defaults**, instead of configuring every app.

- **Dictation service (microphone button):** Browser, Azure Speech or vLLM Realtime. Every app
  whose Speech Recognition Service is **Platform default** follows it, including later changes.
- **Transcription model (recording):** used for recordings and audio/video uploads in apps that
  enable transcription without choosing a model.
- Apps that select a service or model of their own keep it. A new **Browser (Web Speech API)**
  choice pins an app to the browser whatever the default.
- If the default names a backend that is not enabled, apps following it keep using the browser,
  and the admin page warns about it.
- Nothing changes on upgrade: the default starts as the browser, which is what "Default" meant
  before.

## Voice Input: Test Microphone, Dictation and Recording From the Admin Page

**Admin → Voice Input** has a new **Test voice input** panel. The tests run in the admin's own
browser with their microphone, on the same path users take in a chat, against the saved
configuration.

- **Microphone check:** a live input level meter and the device name, with no speech service
  involved.
- **Live dictation:** pick Browser, Azure Speech or vLLM Realtime plus a language and mode, then
  speak. Shows the text as it arrives and how long the first words took.
- **Recording:** record up to 60 seconds and transcribe it with any enabled transcription model.
  Shows the transcript and timings, or the error including the server's reason.
- **Azure Speech** gets a **Test connection** button that checks the key and region from the
  server.
- The vLLM Realtime **Test connection** now explains a redirect: an endpoint behind a proxy that
  only accepts TLS is reported as "use wss:// instead of ws://" rather than a bare HTTP 308.
