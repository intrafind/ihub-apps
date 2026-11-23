# Fixes — Unreleased

## App Conversation: Typing No Longer Jumps into the Test Chat

When an app opened under **Edit with → Conversation**, the test chat beside it took the keyboard
focus as soon as it had loaded. Text typed into "Tell the builder what to change" in the first
moments then ended up in the test chat's message box. The test chat now leaves the focus in the
builder's message box; **Restart** in the test chat still moves the focus to the test chat.
