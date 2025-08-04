# 🎉 New Feature: Automatic Default Configuration Setup

AI Hub Apps now provides a **smooth installation experience** with zero configuration required!

## What's New

When you start the AI Hub Apps server for the first time, it automatically:

- ✅ **Detects empty configuration**: Checks if your `contents` directory is empty
- ✅ **Copies default setup**: Automatically copies all configuration files from `configs/default`
- ✅ **Ready to use**: Server starts immediately with working apps, models, and settings
- ✅ **Non-destructive**: Never overwrites existing configuration files

## Benefits

### For New Users

- **Zero setup**: Clone, install, run - that's it!
- **No manual configuration**: No need to copy files or edit configs
- **Instant functionality**: All apps and features work immediately

### For Developers

- **Faster onboarding**: New team members can start instantly
- **Consistent environments**: Everyone starts with the same baseline
- **Simplified testing**: Clean environments set up automatically

### For Deployment

- **Production ready**: Works in packaged binaries and Docker containers
- **Custom directories**: Respects `CONTENTS_DIR` environment variable
- **Reliable startup**: Graceful error handling with clear feedback

## How It Works

### First Startup

```bash
npm run dev
```

**Console output:**

```
🔍 Checking if initial setup is required...
📦 Contents directory is empty, performing initial setup...
📋 Copying default configuration to contents
✅ Default configuration copied successfully
```

### Subsequent Startups

```bash
npm run dev
```

**Console output:**

```
🔍 Checking if initial setup is required...
✅ Contents directory already exists, skipping initial setup
```

## Custom Contents Directory

Works with any custom contents directory:

```bash
CONTENTS_DIR=/path/to/my-config npm run dev
```

The setup will automatically populate your custom directory.

## What Gets Copied

- **Apps**: 9 pre-configured AI applications
- **Models**: 9 AI model configurations (OpenAI, Anthropic, Google, etc.)
- **Prompts**: 4 prompt templates
- **Pages**: Static pages (FAQ, privacy, terms) in English and German
- **Sources**: Documentation and FAQ content
- **Config**: Platform settings, groups, styles, tools, UI configuration

## Backward Compatibility

This feature is **100% backward compatible**:

- Existing installations are completely unaffected
- Setup only runs when the contents directory is empty
- No changes to configuration file formats or server behavior

## For More Information

- **Full Documentation**: See updated [README.md](README.md) and [docs/](docs/)
- **Technical Details**: [concepts/2025-08-04 Automatic Default Configuration Setup.md](concepts/2025-08-04%20Automatic%20Default%20Configuration%20Setup.md)
- **Development Guide**: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)

---

**Happy coding!** 🚀 Your AI Hub Apps experience just got smoother.
