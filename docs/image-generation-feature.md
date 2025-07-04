# Image Generation Feature

This feature enables apps to create images using models such as DALL‑E 3 or Google Imagen 4. Users interact through the normal chat interface. When an app is configured to use an image model, the last user message is sent to the image API and the resulting picture is returned as part of the assistant response.

Generated files are stored in `attachments/` and can be downloaded via `/api/apps/{appId}/chat/{chatId}/attachments/{attachmentId}`.

To enable image generation configure a model in `config/models.json` and reference it in an app. Provide an API key in `OPENAI_IMAGE_API_KEY` or `GOOGLE_IMAGEN_API_KEY`.
