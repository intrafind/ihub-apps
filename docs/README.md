# iHub Apps Documentation

This book contains configuration details and user instructions for the iHub Apps platform — an AI-powered applications platform with LLM integration.

New here? Start with [Getting Started](GETTING_STARTED.md), then take the tour in the [User Guide](user-guide.md) and the [Admin UI Guide](admin-ui.md) — both with screenshots of the current interface.

## Quick Start

- [Getting Started](GETTING_STARTED.md) - Quick setup and first steps
- [Installation Guide](INSTALLATION.md) - Detailed installation instructions
- [User Guide](user-guide.md) - End-user documentation
- [Admin UI Guide](admin-ui.md) - Navigating and using the admin area, with screenshots
- [Core Concepts](concepts.md) - Providers, models, apps, skills, sources, and tools — and when to use which
- [Architecture Overview](architecture.md) - System architecture and components

## Configuration

- [Customizing iHub Apps](customization.md) - Override labels, translations, and branding via the `contents/` folder
- [App Configuration](apps.md) - AI application setup and management
- [Custom Response Renderers](custom-renderers.md) - Custom output rendering
- [Models](models.md) - LLM model configuration
- [UI Configuration](ui.md) - User interface customization
- [Icons](icons.md) - Available icon reference
- [Platform Configuration](platform.md) - Core platform settings
- [Styles](styles.md) - Writing styles and output formatting
- [Prompts Database](prompts.md) - Reusable prompt templates
- [Content Management](content-management.md) - Page and content management
- [Sources System](sources.md) - Knowledge source integration
- [Mimetype Configuration](mimetypes.md) - File type mapping
- [Configuration Validation](configuration-validation.md) - Config validation and troubleshooting
- [Configuration Migrations](configuration-migrations.md) - Version migration system
- [Configuration Storage](configuration.md) - How config files are read and written
- [Localization](localization.md) - Multi-language support

## Authentication & Security

- [Authentication Architecture](authentication-architecture.md) - Authentication system overview
- [Authentication Quick Start](AUTHENTICATION_QUICK_START.md) - Fast authentication setup
- [External Authentication](external-authentication.md) - Security and user management
- [JWT Authentication](jwt-authentication.md) - Token-based authentication
- [JWT Well-Known Endpoints](jwt-well-known-endpoints.md) - JWT discovery endpoints
- [OIDC Authentication](oidc-authentication.md) - Enterprise SSO setup
- [ADFS Authentication Guide](ADFS-AUTHENTICATION-GUIDE.md) - Microsoft ADFS integration
- [OAuth Authorization Code Flow](oauth-authorization-code.md) - OAuth flow implementation
- [OAuth Integration Guide](oauth-integration-guide.md) - OAuth setup guide
- [API Curl Examples](oauth-api-examples.md) - API authentication examples
- [Personal API Keys](personal-api-keys.md) - API keys users create for themselves
- [Using iHub as OIDC Identity Provider](ihub-as-oidc-idp.md) - iHub as identity provider
- [LDAP/NTLM Authentication](ldap-ntlm-authentication.md) - Windows authentication
- [LDAP Group Lookup Quick Start](LDAP-GROUP-LOOKUP-QUICKSTART.md) - LDAP group setup
- [LDAP Group Mapping Troubleshooting](LDAP-GROUP-MAPPING-TROUBLESHOOTING.md) - LDAP debugging
- [NTLM Technical Reference](ntlm-technical-reference.md) - NTLM authentication details
- [Value Encryption Tool](value-encryption-tool.md) - Secret encryption utility
- [Value Encryption Tool UI](value-encryption-tool-ui.md) - Encryption UI guide
- [Encryption Key Management](encryption-key-management.md) - Key management guide
- [Security Guide](security.md) - Comprehensive security implementation
- [SSL Certificates](ssl-certificates.md) - SSL/TLS configuration
- [Logging](logging.md) - System logging configuration
- [PII Data Handling](pii-data-handling.md) - How personal data is handled

## Features

- [Tool Calling](tool-calling.md) - LLM tool/function calling
- [MCP Integration](mcp-integration.md) - Connect MCP servers as tools, MCP Apps, per-user sign-in
- [Remote A2A Agents as Tools](a2a-agents.md) - Use remote A2A agents as tools
- [Ask User Tool](ask-user-tool.md) - Interactive user prompts
- [Structured Output](structured-output.md) - Structured LLM responses
- [Tools (Legacy)](tools.md) - Legacy tool integration
- [Compare Mode](compare-mode.md) - Two models answer side by side
- [Auto-Send Query Parameter](auto-send-feature.md) - Automatic message submission
- [Feedback Feature](feedback-feature.md) - User feedback system
- [iFinder Integration](iFinder-Integration.md) - Enterprise document management
- [iFinder Quick Reference](iFinder-Quick-Reference.md) - Quick reference guide
- [iFinder iAssistant Admin Guide](ifinder-iassistant-admin-guide.md) - iAssistant administration
- [iFinder Keyless (OIDC/OAuth) JWT](ifinder-oidc-jwt.md) - Keyless iFinder access with OIDC/OAuth tokens
- [iFinder JWT Key Generation](ifinder-jwt-key-generation.md) - JWT setup for iFinder
- [JIRA Integration](JIRA_INTEGRATION.md) - Atlassian JIRA integration
- [File Upload Feature](file-upload-feature.md) - File processing capabilities
- [Google Drive Integration](google-drive-integration.md) - Google Drive file access
- [Office 365 Integration](office365-integration.md) - Microsoft cloud integration
- [Nextcloud Integration](nextcloud-integration.md) - Nextcloud files as a source
- [Nextcloud Embed Plugin](nextcloud-embed.md) - iHub inside Nextcloud
- [Outlook Add-in Rollout](outlook-add-in.md) - Roll out and configure the Outlook add-in
- [Browser Extension](browser-extension.md) - Chat about the page you are reading
- [Audio File Support](audio-file-support.md) - Audio file processing
- [Audio Extraction](audio-extraction.md) - Audio content extraction
- [Audio UI Guide](AUDIO_UI_GUIDE.md) - Audio feature user interface
- [Microphone Feature](microphone-feature.md) - Voice input capabilities
- [Realtime Voice & Transcription](voice-transcription.md) - Recording and file transcription, dictation, Voxtral and Gemini backends
- [Read Aloud (Text-to-Speech)](text-to-speech.md) - Read chat messages aloud
- [Web Tools](web-tools.md) - Web search and content extraction
- [Answer Sources](answer-sources.md) - Sources panel and numbered citations
- [Magic Prompt](magic-prompt-feature.md) - AI-assisted prompt generation
- [Image Upload Feature](image-upload-feature.md) - Image processing and analysis
- [OCR Feature](ocr-feature.md) - Optical character recognition
- [React Component Feature](react-component-feature.md) - Dynamic React page rendering
- [Workflows](workflows.md) - Agentic multi-step workflows
- [Scheduled Tasks](scheduled-tasks.md) - Prompts that run by themselves, as their owner
- [Marketplace](marketplace.md) - Install apps, skills, models, workflows and prompts from registries
- [Agent Factory (V1)](agents.md) - Autonomous agent profiles (preview)
- [OpenAI-Compatible API](openai-compatible-api.md) - Call iHub apps and models through an OpenAI-compatible API
- [Server Configuration](server-config.md) - Server setup and tuning
- [Environment Variables](environment-variables.md) - Environment configuration

## Operations

- [Proxy Configuration](proxy-configuration.md) - Proxy server setup
- [Proxy Testing Guide](proxy-testing-guide.md) - Proxy testing procedures
- [Running with SSL/HTTPS](ssl-https-setup.md) - Serve iHub over HTTPS
- [Production Reverse Proxy Guide](production-reverse-proxy-guide.md) - Production proxy setup
- [Windows Service](windows-service.md) - Run iHub as a Windows service
- [Rate Limiting](rate-limiting.md) - API rate limiting
- [Scaling with Multiple Workers](scaling.md) - Multiple worker processes
- [Multi-Server Deployment](multi-server-deployment.md) - Several servers behind a load balancer
- [Telemetry & Observability](telemetry.md) - OpenTelemetry metrics and traces

## Development & Deployment

- [Developer Onboarding](developer-onboarding.md) - Complete development setup
- [Building an Integration](integration-development.md) - Write a new integration
- [LLM Client](llm-client.md) - The server-side LLM client
- [Agent Loop](agent-loop.md) - How tool-calling turns run
- [SSE v2 Streaming](sse-v2.md) - The streaming protocol
- [Run Ledger](run-ledger.md) - Durable record of every turn
- [Storage Providers](storage.md) - Filesystem and other storage providers
- [Chat Persistence](chat-persistence.md) - Server-side chat history
- [Chat Sharing](chat-sharing.md) - Read-only links to stored chats
- [Artifacts](artifacts.md) - Files produced in a chat
- [Docker Quick Reference](DOCKER-QUICK-REFERENCE.md) - Fast Docker commands
- [Architecture Diagrams](diagrams.md) - Visual system documentation
- [Troubleshooting](troubleshooting.md) - Problem diagnosis and solutions
- [Release Process](release-process.md) - Release management guide
- [Local LLM Providers](local-llm-providers.md) - Local model integration
- [vLLM Server Start Parameters](vllm-server-parameters.md) - Recommended vLLM start parameters

## Accessibility

- [Accessibility](accessibility.md) - Accessibility features and compliance

## FAQ

- [FAQ (English)](ihub-faq-en.md) - Frequently asked questions
- [FAQ (Deutsch)](ihub-faq-de.md) - Häufig gestellte Fragen

---

**Full Documentation Portal**: The complete documentation is also available as an interactive mdBook at `/help` when running the application.
