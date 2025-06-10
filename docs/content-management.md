## Content Management

AI Hub Apps uses a content management system based on Markdown files stored in the `contents/` directory. These files serve multiple purposes:

1. Source material for knowledge-based AI apps
2. Static page content for the application
3. Documentation and supplementary information

### Content Directory Structure

The `contents/` directory contains Markdown (.md) files that can be referenced by the application:

```
contents/
  docs/index.md  - Main documentation file
  faq.md           - Frequently asked questions
  [other-content].md - Additional content files
```

### Using Content in Apps

Content files can be incorporated into apps using the `sourcePath` property in app configurations:

```json
{
  "id": "faq-bot",
  "name": {
    "en": "FAQ Bot",
    "de": "FAQ-Bot"
  },
  // Other app properties...
  "sourcePath": "/contents/faq.md",
  "system": {
    "en": "You are a helpful FAQ assistant. Your job is to answer user questions based ONLY on the information provided in the sources section...",
    "de": "Du bist ein hilfreicher FAQ-Assistent..."
  }
}
```

When an app has a `sourcePath` defined:
- The contents of the specified file are loaded when the app is used
- The content is made available to the app through variables (typically `{{source}}` or `{{content}}`)
- The app can reference, search, and use this content when generating responses

### Markdown Content Format

Content files use standard Markdown with some specific conventions:

1. **Headings**: Use headings (# to ######) to structure content hierarchically
2. **Lists**: Use bullet and numbered lists for enumerated information
3. **Code blocks**: Use triple backticks (```) for code examples
4. **Tables**: Use Markdown tables where appropriate
5. **Images**: Images can be referenced using standard Markdown syntax
6. **Links**: Internal and external links work normally

Example from the FAQ content:

```markdown
# Frequently Asked Questions

## General Questions

### What is AI Hub Apps?
AI Hub Apps is a platform that provides a collection of specialized AI assistants...

### How do I start using an app?
Simply click on any app tile from the main dashboard...
```

### Static Page Integration

Content can be used as static pages in the UI configuration:

```json
"pages": {
  "faq": {
    "title": {
      "en": "Frequently Asked Questions",
      "de": "Häufig gestellte Fragen"
    },
    "content": {
      "en": "# Frequently Asked Questions\n\n**Last Updated...",
      "de": "# Häufig gestellte Fragen\n\n**Zuletzt aktualisiert..."
    }
  }
}
```

For larger content, it's better to reference files from the contents directory rather than embedding them directly in the configuration.

### Content Guidelines

For best results with AI-powered applications:

1. Structure content with clear headings and sections
2. Keep individual sections focused on a single topic
3. Use concise language that's easy to understand
4. Avoid excessive formatting that might confuse the AI
5. Update content regularly to ensure accuracy
6. Include a variety of question forms for FAQ content to improve matching

### Content Updates

To update content:

1. Edit the relevant .md file in the `contents/` directory
2. Save the changes
3. The application will automatically use the updated content on next access

No server restart is required when updating content files, as they are loaded dynamically when accessed.

