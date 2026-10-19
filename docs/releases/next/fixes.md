# Fixes — Unreleased

- **Voice mode no longer makes translation apps answer instead of translate.** The voice style instruction used to tell the model that the user was talking to it, which overrode apps whose messages are meant for someone else, such as Babelfish: saying "Wie heißen Sie?" returned "English" instead of "What is your name?". The instruction now only describes how the answer sounds and leaves the app's own role and instructions in force.
