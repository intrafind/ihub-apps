# iHub FAQ - Frequently Asked Questions

## General Questions

### What is iHub?
iHub is a complete installation package solution (ZIP or Container Image) from IntraFind for AI-powered micro-apps. It's ready to use immediately and can be operated on-premises or GDPR-compliant in the cloud.

### Is iHub free?
Yes, iHub is free and ready to use immediately. The micro-apps are also extensible.

## Hardware & Infrastructure

### What hardware do I need for iHub?
**For iHub itself (without local LLM):**
- You only need a regular workstation or VM with Windows/macOS/Linux
- No GPU is required as long as you use an external LLM via API

**If you want to run a local LLM:**
- GPU requirements are determined individually with IntraFind
- Alternatively, IntraFind can operate the LLM on dedicated GPU hardware in German data centers for you

### Which GPU do I need?
GPU selection is done case-by-case together with IntraFind, depending on:
- Your specific use case
- Desired model size
- Target latency and number of users
- IntraFind will advise on the appropriate GPU class or alternatively offer managed operation

## LLM Integration

### What LLM operating options are available?
1. **Cloud LLM**: OpenAI, Mistral, Anthropic, Google with API key (no local GPU needed)
2. **IntraFind-operated LLM**: Dedicated GPU hardware in German data centers, multi-tenant separated and end-to-end encrypted
3. **Own local LLM**: Operation in your own infrastructure with your own GPU (must be OpenAI API compatible - like LM Studio, ollama, llama.cpp, vLLM or similar)

### Where can I download an LLM?
**Option A - Cloud Provider (no download needed):**
- Use OpenAI, Mistral, Anthropic, or Google
- Simply enter the API key in iHub

**Option B - LLM by IntraFind (no download by you):**
- IntraFind operates dedicated open-source models for you
- Connection via secured line without your own model

**Option C - Own local LLM:**
- Download via common model repositories
- Specific model selection is coordinated project-specifically with IntraFind

### Where do I install the LLM?
- **Cloud LLM**: No installation target needed, just enter API key
- **LLM by IntraFind**: Runs in IntraFind cloud on dedicated GPU
- **Own local LLM**: Installation in your infrastructure (server/VM with GPU)

### How do I integrate the LLM into iHub?
1. **Download & extract iHub**
2. **Choose API access:**
   - Cloud models: Enter API key in `config.env`
   - Local model: Adjust model config in `contents/models/local-vllm.json` or create new one
3. **Start iHub** with the appropriate start script
4. **Open browser**: http://localhost:3001/

## Installation & Configuration

### How do I install iHub in 10 minutes?
1. **Download iHub** from the product page or GitHub
2. **Extract ZIP**
3. **Choose LLM option**: Cloud LLM, IntraFind LLM, or own local LLM
4. **Configure**: Fill `config.env` with API keys or adjust `contents/models/local-vllm.json` or similar
5. **Start**: Execute appropriate start script (`.bat` for Windows, `.sh` for macOS/Linux) or start container
6. **Open browser**: http://localhost:3001/
7. **Test**: Try out the included micro-apps

### What else needs to be configured in iHub?
- **config.env**: Enter API keys for cloud models
- **Model profiles**: For local LLM, adjust `contents/models/local-vllm.json`
- **Secure operation**: E2E encryption and IP whitelisting with IntraFind LLM
- **Operating mode**: Choice between on-premises or cloud operation

### Which cloud providers are supported?
- Google
- Mistral
- Anthropic
- OpenAI/Azure OpenAI

## Micro-Apps & Prompts

### How do I create a prompt and a new tile?
1. **Use existing micro-app as template** (recommended):
   - Start iHub
   - Select existing micro-app (e.g., "Compose email")
   - Settings/Duplicate
   - Adjust prompt components
   - The tile appears automatically on the iHub start screen

2. **Create your own micro-app**:
   - GitHub repo contains examples and documentation
   - See folders `examples`, `docs`, as well as `AGENTS.md` and `LLM_GUIDELINES.md`
   - Complete documentation in running iHub under `/help`

### Are prompt skills required?
No, iHub is explicitly designed for "no prompt skills needed". The input forms lead to the desired result.

### Where can I find more AI assistants/iHub tiles?
- **Official iHub repo**: [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
  - Sample apps
  - Documentation
  - Releases
- **IntraFind GitHub organization**: [github.com/intrafind](https://github.com/intrafind)
- **IntraFind iHub Homepage**: [github.com/intrafind](http://intrafind.com/ihub)

## Security & Privacy

### Is iHub GDPR-compliant?
Yes, iHub can be operated GDPR-compliant in the cloud. With the IntraFind LLM variant:
- End-to-end encryption is used
- IP whitelisting is implemented
- Data is not used for training purposes
- Multi-tenant separation is guaranteed

### Where is data processed?
Depending on the chosen option:
- **Cloud LLM**: At the respective cloud provider
- **IntraFind LLM**: In German data centers (AWS, Azure, Hetzner)
- **Local LLM**: In your own infrastructure

## Support & Documentation

### Where can I find the complete documentation?
- **In running iHub**: Under `/help` as mdBook
- **GitHub repository**: [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
- **Files in iHub package**: `docs` folder with guides

### How do I get support?
- First consult the integrated documentation under `/help`
- Check the GitHub repository for current updates
- Contact IntraFind for project-specific consultation on model selection and GPU configuration

### Which files are important for configuration?
- `config.env`: API keys for cloud models
- `contents/models/local-vllm.json`: Configuration for local models
- Start scripts: `ihub-apps-<version>-win.bat` / `-macos` / `-linux`

## Technical Details

### Which operating systems are supported?
- Windows
- macOS
- Linux 

### On which port does iHub run?
iHub runs by default on port 3001 (http://localhost:3001/)

### Can I develop my own micro-apps?
Yes, iHub is extensible. You can:
- Duplicate and customize existing apps
- Create new apps based on the examples
- Use the documentation under `/help` for development guides

## Quick Start Guide

### Getting started with iHub - Step by step
1. **Download iHub** from [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
2. **Extract the ZIP file**
3. **Choose your LLM approach**:
   - Cloud LLM (API key required)
   - LLM via IntraFind (managed service)
   - Own local LLM (GPU required)
4. **Configure**:
   - For cloud: Add API keys to `config.env`
   - For local: Modify `contents/models/local-vllm.json`
5. **Start iHub**:
   - Windows: Run `ihub-apps-<version>-win.bat`
   - macOS: Run `ihub-apps-<version>-macos`
   - Linux: Run `ihub-apps-<version>-linux`
6. **Open browser**: Navigate to http://localhost:3001/
7. **Test**: Try one of the pre-installed micro-apps

### Best practices for beginners
- Start with cloud LLMs for the easiest setup
- Use existing micro-apps as templates
- Consult the `/help` documentation in the running iHub
- Begin with simple prompt modifications before creating new apps

## Advanced Topics

### Multi-tenant operation
When using IntraFind's managed LLM service:
- Complete tenant separation is ensured
- Each customer gets dedicated GPU resources
- Data isolation is guaranteed
- No cross-contamination between customers

### Scaling considerations
- For high-volume use cases, consult with IntraFind
- GPU requirements scale with:
  - Number of concurrent users
  - Model size
  - Required response time
- IntraFind can provide tailored recommendations

### Integration possibilities
- iHub can be integrated into existing IT landscapes
- API access for programmatic interaction
- Customizable micro-apps for specific workflows
- Support for various authentication methods (consult documentation)
