# Running iHub Apps as a Windows Service

iHub Apps can be registered as a native Windows Service so it starts automatically with Windows, runs in the background without a logged-in user, and restarts automatically on failure.

This feature is available for the **binary (zip) installation** on Windows 10 or later.

## Requirements

- Windows 10 (1809) or Windows Server 2019 or later
- Administrator privileges (needed to install/remove a service)
- Internet access during installation (to download the WinSW service wrapper, ~900 KB; one-time download)

## Installation

### Step 1 — Extract the binary zip

Download and extract `ihub-apps-vX.Y.Z-win.zip` to a permanent location such as `C:\ihub-apps`.

The zip contains all files the service needs, including `install-service.cmd`.

### Step 2 — Configure iHub Apps (optional but recommended)

Create or edit `C:\ihub-apps\config.env` to set your API keys and port before the service is installed:

```ini
PORT=3000
OPENAI_API_KEY=your-key-here
ANTHROPIC_API_KEY=your-key-here
```

### Step 3 — Run the installer

Right-click `install-service.cmd` and choose **Run as administrator**.

The script will:

1. Download [WinSW](https://github.com/winsw/winsw) (a lightweight Windows Service wrapper) and save it as `ihub-apps-service.exe` — this is a one-time ~900 KB download.
2. Register iHub Apps as a Windows Service named **"iHub Apps"**.

After the installer finishes, start the service:

```cmd
sc start "iHub Apps"
```

Or open **Services** (`services.msc`), find **iHub Apps**, and click **Start**.

## Service behaviour

| Property | Value |
|---|---|
| Service name | `iHub Apps` |
| Display name | iHub Apps |
| Startup type | Automatic (starts with Windows) |
| Restart on failure | Yes — after 10 s, 30 s, then 1 min |
| Log files | `<install-dir>\logs\` |

The service runs `node.exe launcher.cjs` inside the installation directory. The `config.env` file is read from that same directory at startup.

## Managing the service

### Start / stop / restart

```cmd
sc start "iHub Apps"
sc stop  "iHub Apps"
sc stop  "iHub Apps" && sc start "iHub Apps"
```

Or use **Services** (`services.msc`) for a graphical interface.

### View logs

WinSW writes stdout/stderr of the Node.js process to rolling log files under `<install-dir>\logs\`. Open these files in any text editor to diagnose startup or runtime problems.

### Check service status

```cmd
sc query "iHub Apps"
```

Or in PowerShell:

```powershell
Get-Service "iHub Apps"
```

## Updating iHub Apps

The in-place auto-update (Admin → System → Check for Updates) works normally when running as a service. After an update is applied the server exits with code 75, which causes WinSW to restart it — the new version loads automatically.

To update manually:

1. Stop the service: `sc stop "iHub Apps"`
2. Replace `node.exe`, `launcher.cjs`, `server\`, and `public\` with files from the new zip.
3. Start the service: `sc start "iHub Apps"`

Alternatively, uninstall the service first, extract the new zip over the old directory, then run `install-service.cmd` again — this preserves `contents\` (your configuration).

## Uninstalling the service

Right-click `uninstall-service.cmd` and choose **Run as administrator**.

The script stops and removes the service. Your `contents\` configuration directory and log files are not deleted.

## Troubleshooting

### The installer says "Failed to download WinSW"

Your network may block GitHub. Download `WinSW-x64.exe` from [https://github.com/winsw/winsw/releases/tag/v2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0), rename it to `ihub-apps-service.exe`, place it alongside `install-service.cmd`, then run the installer again.

### The service appears in Services.msc but fails to start

1. Check `<install-dir>\logs\` for error messages.
2. Verify `node.exe` exists in the installation directory.
3. Confirm `config.env` is readable and `PORT` is not already in use.
4. Try running the app interactively first to rule out configuration issues:
   ```cmd
   cd C:\ihub-apps
   .\ihub-apps-vX.Y.Z-win.bat
   ```

### Port conflict on startup

Set a different port in `config.env`:

```ini
PORT=3001
```

Then restart the service.

### Service was installed but "iHub Apps" is not in Services.msc

Run `install-service.cmd` again as Administrator — or check if the service is registered under a different name with:

```cmd
sc query type= all state= all | findstr /i "ihub"
```
