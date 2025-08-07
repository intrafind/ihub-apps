## Content Management

iHub Apps uses a content management system based on Markdown files stored in the `contents/` directory. These files serve multiple purposes:

1. Source material for knowledge-based AI apps
2. Static page content for the application
3. Documentation and supplementary information

### Automatic Content Setup

**New Feature**: When starting iHub Apps for the first time, the system automatically creates the `contents/` directory with default content files.

**What gets copied automatically:**
- Configuration files (platform settings, apps, models, etc.)
- Default source content (documentation, FAQ)
- Page templates (privacy policy, terms, FAQ pages)
- Prompt templates and examples

**When it runs:**
- Only when the `contents/` directory is empty or doesn't exist
- Copies from `server/defaults/` to your configured `CONTENTS_DIR`
- Never overwrites existing content

### Content Directory Structure

The `contents/` directory contains Markdown (.md) files that can be referenced by the application:

```
contents/
  sources/
    documentation.md - Main documentation file
    faq.md          - Frequently asked questions
  pages/
    en/
      faq.md        - FAQ page content
      privacy.md    - Privacy policy
      terms.md      - Terms of service
    de/
      faq.md        - German FAQ
      privacy.md    - German privacy policy
      terms.md      - German terms
  config/           - Configuration files
  apps/            - App definitions
  models/          - Model configurations
  prompts/         - Prompt templates
```

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

### What is iHub Apps?

iHub Apps is a platform that provides a collection of specialized AI assistants...

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
