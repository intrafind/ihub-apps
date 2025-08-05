# Getting Started with AI Hub Apps

## Quick Start (No Authentication Required)

**AI Hub Apps works immediately without any setup!**

```bash
# 1. Clone and install
git clone <repository>
cd ai-hub-apps
npm run install:all

# 2. Start the application (automatic setup included!)
npm run dev

# 3. Open your browser
# Visit http://localhost:5173
```

**That's it!** The server automatically creates default configuration files on first startup.

### What Happens During First Startup

When you start the server for the first time:

1. 🔍 **Smart Detection**: Checks if configuration directory is empty
2. 📋 **Auto-Setup**: Copies default configuration from `server/defaults`
3. ✅ **Ready to Use**: All apps, models, and settings configured automatically
4. 🚀 **Normal Startup**: Server continues and you can start using AI Hub Apps

**Console output example:**
```
🔍 Checking if initial setup is required...
📦 Contents directory is empty, performing initial setup...
📋 Copying default configuration from server/defaults to contents
✅ Default configuration copied successfully
```

**On subsequent startups:**
```
🔍 Checking if initial setup is required...
✅ Contents directory already exists and is not empty, skipping initial setup
```

## What You Get Out of the Box

✅ **Full Access**: All users can access all apps, models, and features  
✅ **No Login Required**: Anonymous access enabled by default  
✅ **30+ AI Apps**: Chat, translation, summarization, analysis tools, and more  
✅ **Multiple AI Models**: Support for OpenAI, Anthropic, Google, and local models  
✅ **Zero Configuration**: Works immediately with sensible defaults

## Default Configuration Summary

```json
{
  "authentication": "disabled (anonymous access allowed)",
  "userAccess": "full (all apps, models, prompts)",
  "adminPanel": "available (separate authentication)",
  "restrictions": "none (completely open by default)"
}
```

## When to Enable Authentication

Consider enabling authentication if you need:

- **👤 User Tracking**: Know who is using which features
- **🔒 Access Control**: Restrict apps/models to specific users or groups
- **📊 Usage Analytics**: Track usage per user or department
- **🏢 Corporate Integration**: Connect with existing SSO/identity systems
- **📋 Compliance**: Meet security or audit requirements

## Authentication Options

### Option 1: Keep Default (Recommended for Testing)

- **Setup**: None required
- **Users**: Everyone has full access
- **Best For**: Development, testing, personal use

### Option 2: Add Local Authentication

- **Setup**: Enable local auth, create user accounts
- **Users**: Username/password login with different permission levels
- **Best For**: Small teams, controlled environments

### Option 3: Corporate SSO Integration

- **Setup**: Configure reverse proxy with corporate authentication
- **Users**: Authenticate via existing corporate identity provider
- **Best For**: Enterprise deployments, existing SSO infrastructure

### Option 4: Restricted Anonymous Access

- **Setup**: Modify group permissions to limit anonymous access
- **Users**: Anonymous users see limited apps/models
- **Best For**: Public deployments with controlled feature access

## Next Steps

1. **Start using the apps**: Visit http://localhost:5173 and explore the available applications
2. **Check the admin panel**: Visit http://localhost:5173/admin for configuration options
3. **Review authentication options**: See [docs/external-authentication.md](external-authentication.md) for detailed configuration
4. **Configure API keys**: Add your AI provider API keys in `.env` for full functionality

## Need Help?

- 📖 **Full Documentation**: [docs/external-authentication.md](external-authentication.md)
- 🧪 **Test Authentication**: Run `./test-authentication.sh`
- 🔧 **Configuration Examples**: See [docs/external-authentication.md#quick-start-scenarios](external-authentication.md#quick-start-scenarios)

---

**Remember**: AI Hub Apps is designed to be functional and useful immediately, with authentication as an optional enhancement rather than a requirement!
