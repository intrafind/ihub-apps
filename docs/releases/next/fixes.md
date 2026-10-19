# Fixes — Unreleased

## Translator No Longer Gets Stuck Thinking, Default Apps Use Temperature 0.7 or Higher

With a reasoning model such as Qwen3.6 on vLLM, the Translator could think until it ran out of
tokens and never give an answer. A low temperature makes reasoning models repeat themselves, and
several apps asked for 0.2–0.4. The Translator now has thinking turned off, since a translation does
not need it. No bundled app asks for a temperature below 0.7 any more.

- Applies to new installations. Existing apps keep their stored settings. Change them under
  **Admin → Apps**, or reinstall the app.
