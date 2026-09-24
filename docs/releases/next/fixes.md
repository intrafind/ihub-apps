# Fixes — Unreleased

## iHub Support Bot: Documentation Available in Docker and Production Builds

In Docker images, the iHub Support Bot had no iHub documentation to answer from, and installations
built with `npm run prod:build` could ship the documentation of an earlier build or none at all —
the documentation source was generated after the server files were packaged, or not at all. Every
build now generates it before packaging, so the bot answers from the documentation of the version
it runs.
