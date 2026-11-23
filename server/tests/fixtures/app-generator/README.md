# Answers of the app draft generator

Each `.txt` file is the raw answer of a model to a draft request
(`POST /api/admin/apps/_generate`), exactly as the model wrote it.
`server/tests/app-generator-sanitize.test.js` runs every file through the
parser and the sanitiser. The start of the file name says what must happen:

| File name starts with | The answer must                                                                     |
| --------------------- | ----------------------------------------------------------------------------------- |
| `ok-`                 | become an app that passes the app schema, without bindings, not published           |
| `not-json-`           | be refused with the reason `not-json`                                               |
| `truncated-`          | be refused with the reason `truncated` (the test passes the finish reason `length`) |
| `incomplete-`         | be refused with the reason `incomplete`                                             |

A file with another prefix fails the test.

The files here are hand-written. When the ten descriptions of
`tests/manual/app-builder-descriptions.md` are run against a real model, store
each raw answer here as `ok-<model>-<number>.txt`, or under the prefix of the
outcome the answer should have, so the parser is tested against what real
models write.
