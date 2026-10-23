# Breaking Changes — Unreleased

## A chat can no longer be moved into or out of a project (preview)

`PATCH /api/chats/:chatId` with a `projectId` is removed and answers `400`. A chat is in a project from its first turn (the `projectId` of the chat request, which the project page sets); it is never moved afterwards. `attachedProjectIds`, `title` and `temporary: false` work as before. Chats that already live in a project stay there.
