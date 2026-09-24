# Features — Unreleased

## iHub Support Bot: Answers What Each Release Changed

The bundled **iHub Documentation** knowledge source now also holds the release notes of every
release — the same breaking changes, new features and fixes as **Admin → What's New**. The
**iHub Support Bot** can therefore answer questions such as "What is new in 5.5.18?" or "What do I
have to check before upgrading from 5.4 to 5.5?", in addition to questions about the
documentation.

- The release notes always match the installed version: every build generates them, and the server
  refreshes the source on startup after an upgrade.
- The source's description now mentions the release notes, so the model knows to look them up. An
  upgrade updates the description only if you have not changed it.
