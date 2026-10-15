# Breaking Changes — Unreleased

## Every Workflow End Step Needs an Output

The answer of a workflow is now the **Output** of its end step, and every end step must have one.
The `chatIntegration.primaryOutput` setting ("Result shown in chat") is gone, and so is the
guessing behind "Automatic". What the chat shows, and what an API, MCP or A2A caller receives, is
that Output.

**Before upgrading:** The update (migration V166) sets the Output of the end steps of your
workflows: the result you had picked in the chat settings, else the first of `finalReport`,
`report`, `content`, `output`, `result`, `summary`, `text` and `message` that the end step passes
on. A workflow that passed on several variables and named none of them as its answer keeps giving
them as one JSON object: its Output becomes an object with a field for each of those variables, and
the server log lists these end steps, in case you want to name the one that is the answer. The
workflows that ship with iHub are covered. Check the log for end steps it could not decide, such as
one that passes on nothing that can be named: they keep loading, but a run that reaches them fails
and the workflow cannot be saved until you set **Output** in the end step's form of the visual
editor. Workflows that you or your integrators create through the API need an `output` in the
`config` of every end step, a variable or text, or an object of fields.

For MCP and A2A, the answer is now the Output only, and a JSON answer arrives as JSON (structured
content, a data part) next to the text. The **Output format** of an end step no longer replaces the
result: the answer stays in `output`, with `raw` and `text` leaving out the additional information
(`text` writes a JSON answer out). `chatIntegration.passthroughResult` is removed: it never had
an effect, as a workflow called from chat always showed its answer as it is.

## Upload Size Limits Apply per File Type

Every file was accepted up to the largest size limit of the app: in an app with a video limit of
50 MB, a 40 MB PDF was attached although `fileUpload.maxFileSizeMB` is 20. With videos of up to
50 GB that would have meant documents and images of 50 GB. Each file is now held to the limit of
its own type (documents `fileUpload`, images `imageUpload`, audio `audioUpload`, video
`videoUpload`), and the error names that limit.

**Before upgrading:** Users who attach documents or images larger than the limit of their type
get "File too large" where the file used to go through. The defaults are 20 MB for documents, 10 MB
for images, 20 MB for audio and 50 MB for videos. The document default was 5 MB: it is now 20 MB for
apps that do not set a limit and in the app editor, and the default apps that shipped with 5 MB
(Email Composer, File Analyzer, iFinder Document Actions, iHub Support Bot, IntraFind Website Bot,
Content Summarizer, Translator) are raised to 20 MB. The update raises an installed copy of those
apps only where the limit is still exactly 5 MB; a limit you set yourself, in these apps or in your
own, is kept. Raise `fileUpload.maxFileSizeMB` or `imageUpload.maxFileSizeMB` (up to 100 MB each) in
the Upload Configuration of the apps that need more. Raising the video limit no longer raises the
others.
