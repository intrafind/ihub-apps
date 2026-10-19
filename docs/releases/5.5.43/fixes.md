# Fixes — 5.5.43

## Translator and Babelfish No Longer Get Stuck Thinking, Apps Use Temperature 0.7 or Higher

With a reasoning model such as Qwen3.6 on vLLM, the Translator and Babelfish could think until they
ran out of tokens and never give an answer. A low temperature makes reasoning models repeat
themselves, and several apps asked for 0.2–0.4.

- The Translator and Babelfish have thinking turned off, since a translation does not need it. An
  app where an admin already chose whether to think keeps that choice.
- No app uses a temperature below 0.7 any more. Lower values are raised to 0.7 when the server
  starts, including in apps you created or changed yourself. Values of 0.7 and above stay as they
  are.
