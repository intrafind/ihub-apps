# Breaking Changes — Unreleased

## Upload Size Limits Apply per File Type

Every file was accepted up to the largest size limit of the app: in an app with a video limit of
50 MB, a 40 MB PDF was attached although `fileUpload.maxFileSizeMB` is 5. With videos of up to
50 GB that would have meant documents and images of 50 GB. Each file is now held to the limit of
its own type (documents `fileUpload`, images `imageUpload`, audio `audioUpload`, video
`videoUpload`), and the error names that limit.

**Before upgrading:** Users who attach documents or images larger than the limit of their type
get "File too large" where the file used to go through. The defaults are 5 MB for documents, 10 MB
for images, 20 MB for audio and 50 MB for videos. Raise `fileUpload.maxFileSizeMB` or
`imageUpload.maxFileSizeMB` (up to 100 MB each) in the Upload Configuration of the apps that need
more. Raising the video limit no longer raises the others.
