# Feature Name Change: Before and After

## Before

**Feature ID:** `sources`

### English
- **Name:** Knowledge Sources (RAG)
- **Description:** Retrieval-augmented generation with custom knowledge bases

### German
- **Name:** Wissensquellen (RAG)
- **Description:** Retrieval-augmentierte Generierung mit benutzerdefinierten Wissensbasen

---

## After

**Feature ID:** `sources`

### English
- **Name:** Sources
- **Description:** Add custom knowledge sources directly to prompts

### German
- **Name:** Quellen
- **Description:** Benutzerdefinierte Wissensquellen direkt zu Prompts hinzufügen

---

## Why the Change?

The previous naming suggested that the system implements Retrieval-Augmented Generation (RAG), which is a specific AI technique involving vector databases, semantic search, and dynamic retrieval. However, the actual implementation simply adds configured knowledge sources directly to the prompt context.

The new naming is:
- ✅ More accurate - describes what the system actually does
- ✅ Simpler - easier for users to understand
- ✅ Clearer - avoids technical jargon that doesn't apply

## Display Context

This feature appears in the **Admin Panel → Features** section, where administrators can enable/disable platform features. The name and description help admins understand what each feature does before enabling it.
