# Fixes — Unreleased

## Voice Input: Azure Speech Works With On-Prem Containers Again

Voice input with the Azure service failed with "Azure subscription key is not configured" when
it pointed at an on-prem Azure Speech container, which has no key. Leave the subscription key
empty under **Admin → Voice Input** and set the host to the container, or keep the host an app
already sets: the browser now connects to it directly, with no call to Microsoft from the browser
or the iHub server, so this works fully air-gapped. Azure cloud still needs a key. A failed Azure setup now shows its error instead
of a generic "Error starting voice input".

## Chat Export: PDF and Excel Downloads Work Again

Exporting a chat or message as PDF opened the print dialog with a blank page, and exporting as
Excel produced no file at all. PDF export now prints the full conversation, and Excel export
downloads the workbook again.
