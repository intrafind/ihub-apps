# Fixes — Unreleased

## Translator and Babelfish No Longer Get Stuck Thinking

With a reasoning model such as Qwen3.6 on vLLM, the Translator and Babelfish could think until they
ran out of tokens and never give an answer.

- The Translator and Babelfish have thinking turned off, since a translation does not need it. An
  app where an admin already chose whether to think keeps that choice.
- The cause was the low temperature these apps asked for, which makes reasoning models repeat
  themselves. Apps no longer set a temperature at all, see "Temperature Is Set on the Model, Not on
  Apps, Agents or Workflows".
