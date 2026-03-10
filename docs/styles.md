# Styles Configuration

The `styles.json` file (located at `contents/config/styles.json`) defines the optional writing style presets that users can choose when interacting with an app. Each entry maps a style identifier to the instruction text that is appended to the system prompt at runtime.

## Built-in Styles

The following 15 styles (plus the special `keep` sentinel) ship with iHub Apps out of the box:

| Key | Description |
| --- | ----------- |
| `keep` | Special value — leaves the system prompt unchanged (see below) |
| `normal` | Provide default, balanced responses. |
| `concise` | Provide shorter and more direct responses. Be brief and to the point. |
| `formal` | Provide clear, professional and polished responses using formal language. |
| `explanatory` | Provide educational responses that explain concepts clearly, as if teaching a student. |
| `creative` | Provide imaginative and artistic responses, using metaphors and analogies. |
| `persuasive` | Provide convincing and compelling responses, using rhetorical techniques. |
| `humorous` | Provide light-hearted and funny responses, using jokes and puns. |
| `empathetic` | Provide compassionate and understanding responses, showing empathy and support. |
| `friendly` | Provide warm and approachable responses, using a friendly tone. |
| `technical` | Provide detailed and precise responses, using technical language. |
| `casual` | Provide relaxed and informal responses, using everyday language. |
| `detailed` | Provide thorough and comprehensive responses, covering all aspects of the topic. |
| `analytical` | Provide logical and critical responses, analyzing the topic in depth. |
| `assertive` | Provide confident and strong responses, taking a clear stance. |
| `einfache, leichte Sprache` | Rewrites text into plain German (B1 level) following Easy Language rules. |

## Special `keep` Behavior

The `keep` style is a reserved sentinel value. When a user or app selects `keep`, the server recognizes it and does **not** append any style instruction to the system prompt. This preserves the system prompt exactly as written, without any tone or style modification. Use it when you want the LLM to respond in whatever style the system prompt already defines.

## Runtime Flow

At request time the `PromptService.processMessageTemplates()` method appends style text to the resolved system prompt:

1. The user selects a style in the chat interface (or the app `preferredStyle` is used as the default).
2. The server reads the current styles configuration from cache (`configCache.getStyles()`).
3. If the selected style key exists in `styles.json` **and** the key is not `keep`, the corresponding instruction text is appended to the system prompt with two preceding newlines: `systemPrompt += '\n\n' + styles[style]`.
4. If the key is `keep` or does not exist, nothing is appended and the system prompt is used as-is.

## Setting a Default Style in App Config

Use the `preferredStyle` field in an app's JSON configuration to pre-select a style for that app. Users can still override it from the UI unless style selection is disabled.

```json
{
  "id": "my-app",
  "preferredStyle": "formal"
}
```

To hide the style selector entirely for an app, set `disallowStyleSelection` inside `settings`:

```json
{
  "settings": {
    "disallowStyleSelection": true
  }
}
```

## Adding Custom Styles

Open `contents/config/styles.json` and add a new key-value pair. The key becomes the identifier used in app configs and the UI; the value is the instruction appended to the system prompt.

```json
{
  "normal": "Provide default, balanced responses.",
  "pirate": "Respond in the style of a friendly pirate captain. Use nautical vocabulary and occasional 'Arr!'."
}
```

Custom styles appear immediately in the style selector because the configuration is reloaded from cache without a server restart.

## Admin UI

Styles can be reviewed in the admin panel under **UI Customization**. The style selector shown to users lists every key defined in `styles.json` (except `keep`, which is handled transparently). Administrators can edit `styles.json` directly through the **Configuration** section of the admin panel.
