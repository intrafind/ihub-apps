# Styles Configuration

The `styles.json` file defines the optional writing style presets that users can choose when interacting with an app. Each entry maps an identifier to a short instruction that is appended to prompts.

Example structure:

```json
{
  "normal": "Provide default, balanced responses.",
  "formal": "Please use formal language and a professional tone.",
  "humorous": "Provide light-hearted and funny responses, using jokes and puns."
}
```

Any number of styles can be defined. The identifier is referenced by apps through the `preferredStyle` property. Users can select among the available styles unless style selection is disabled via app settings.
