# Fixes — Unreleased

## Chat Message Limit and Artifact Settings Take Effect

Changing `chats.maxMessagesPerChat` or any `artifacts` setting in the platform configuration had
no effect — the server always used the built-in defaults (2000 messages per chat, artifacts on,
10 MB per artifact, 8 per batch). The configured values are now read and apply on the next write,
without a restart.
