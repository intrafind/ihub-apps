# Running iHub Apps as a Windows Service

iHub Apps can be registered as a native Windows Service so it starts automatically with Windows, runs in the background without a logged-in user, and restarts automatically on failure.

This feature is available for the **binary (zip) installation** on Windows 10 or later.

## Requirements

- Windows 10 (1809) or Windows Server 2019 or later
- Administrator privileges (needed to install/remove a service)
- No additional downloads required — the WinSW service wrapper is bundled in the zip

## Installation

### Step 1 — Extract the binary zip

Download and extract `ihub-apps-vX.Y.Z-win.zip` to a permanent location such as `C:\ihub-apps`.

The zip contains all files the service needs, including `install-service.cmd`.

### Step 2 — Configure iHub Apps (optional but recommended)

Create or edit `C:\ihub-apps\config.env` to set the port before the service is installed. API keys are not set here — add your provider in the setup wizard or under **Admin → Providers** after the first start:

```ini
PORT=3000
```

### Step 3 — Run the installer

Right-click `install-service.cmd` and choose **Run as administrator**.

The script will register iHub Apps as a Windows Service named **"iHub Apps"** using the bundled `ihub-apps-service.exe` ([WinSW](https://github.com/winsw/winsw)) that ships in the zip — no internet access is required on the server.

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

**Admin → Updates** works when iHub runs as a service, online (*Download and
verify*) and offline (*Install from file*: upload the `ihub-apps-v<version>-win.zip`
or enter its path on the server). See
[Binary Installation Updates](INSTALLATION.md#binary-installation-updates).

How it works under WinSW: after you confirm the update the server exits with
code 75 and WinSW starts `node.exe launcher.cjs` again (after the 10-second
delay configured in `ihub-apps-service.xml`). The launcher replaces `server\`,
`public\`, `node.exe` and the other application files **before** it starts the
server — a running server cannot rename its own directory on Windows while
files below it are open. If the new version fails to start three times, the
launcher restores the previous one; the Updates page shows the reason.

Notes for Windows:

- The service account needs write access to the installation directory. Avoid
  installing below `C:\Program Files` unless the account has it.
- Mapped drive letters are not visible to the service account. To install
  from a file share, use a UNC path (`\\fileserver\share\ihub-apps-v5.7.0-win.zip`)
  or copy the file into the `updates\` folder of the installation.
- Antivirus software that quarantines the new `node.exe` makes the update fail
  before anything is replaced ("The bundled Node.js binary does not start").
  Exclude the installation directory, or release the file, and try again.
- The service wrapper (`ihub-apps-service.exe`) and `ihub-apps-service.xml` are
  not replaced by an update, so your service settings stay as they are.

To update manually:

1. Stop the service: `sc stop "iHub Apps"`
2. From a command prompt in the installation directory, run
   `node.exe launcher.cjs --update=install --file=C:\path\to\ihub-apps-v<version>-win.zip`
   (or replace `node.exe`, `launcher.cjs`, `server\`, `shared\`, `public\`,
   `docs\`, `version.txt` and the `ihub-apps-v*-win.bat` by hand with the
   files from the new zip).
3. Start the service: `sc start "iHub Apps"`

Alternatively, uninstall the service first, extract the new zip over the old directory, then run `install-service.cmd` again — this preserves `contents\` (your configuration).

## Uninstalling the service

Right-click `uninstall-service.cmd` and choose **Run as administrator**.

The script stops and removes the service. Your `contents\` configuration directory and log files are not deleted.

## Troubleshooting

### The installer says "ihub-apps-service.exe not found"

The distribution zip should include this file. Re-download the Windows zip from the releases page and extract it again — the file may have been accidentally deleted or the zip was incomplete.

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
