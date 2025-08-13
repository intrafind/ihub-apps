# Running iHub Apps as a Linux Service

This guide explains how to set up iHub Apps as a systemd service on Linux systems.

## Prerequisites

- Linux system with systemd
- Node.js 20.0.0 or higher
- iHub Apps installed and configured
- Root or sudo access

## Installation Steps

### 1. Create System User

Create a dedicated user for running the service:

```bash
# Create system user and group
sudo useradd --system --shell /bin/false --home /opt/ihub-apps --create-home ihub-apps
sudo usermod -a -G ihub-apps ihub-apps
```

### 2. Install Application

Install iHub Apps to the system directory:

```bash
# Create installation directory
sudo mkdir -p /opt/ihub-apps
sudo chown ihub-apps:ihub-apps /opt/ihub-apps

# Copy application files (adjust source path as needed)
sudo cp -r /path/to/ihub-apps/* /opt/ihub-apps/
sudo chown -R ihub-apps:ihub-apps /opt/ihub-apps

# Install dependencies
cd /opt/ihub-apps
sudo -u ihub-apps npm run install:all
```

### 3. Configure Environment

Set up the environment file:

```bash
# Copy and configure environment file
sudo cp /opt/ihub-apps/.env.example /opt/ihub-apps/.env
sudo chown ihub-apps:ihub-apps /opt/ihub-apps/.env
sudo chmod 600 /opt/ihub-apps/.env

# Edit the environment file with your API keys and configuration
sudo -u ihub-apps nano /opt/ihub-apps/.env
```

### 4. Install Service File

Copy the systemd service file:

```bash
# Copy service file
sudo cp /opt/ihub-apps/systemd/ihub-apps.service /etc/systemd/system/

# Reload systemd configuration
sudo systemctl daemon-reload
```

### 5. Enable and Start Service

Enable the service to start on boot and start it:

```bash
# Enable service for automatic startup
sudo systemctl enable ihub-apps

# Start the service
sudo systemctl start ihub-apps

# Check service status
sudo systemctl status ihub-apps
```

## Service Management

### Basic Commands

```bash
# Start service
sudo systemctl start ihub-apps

# Stop service
sudo systemctl stop ihub-apps

# Restart service
sudo systemctl restart ihub-apps

# Check status
sudo systemctl status ihub-apps

# Enable/disable auto-start
sudo systemctl enable ihub-apps
sudo systemctl disable ihub-apps
```

### Viewing Logs

```bash
# View recent logs
sudo journalctl -u ihub-apps

# Follow logs in real-time
sudo journalctl -u ihub-apps -f

# View logs from today
sudo journalctl -u ihub-apps --since today

# View logs with specific time range
sudo journalctl -u ihub-apps --since "2024-01-01 00:00:00" --until "2024-01-01 23:59:59"
```

## Configuration

### Service Configuration

The service file includes several configuration options:

- **Working Directory**: `/opt/ihub-apps`
- **User/Group**: `ihub-apps`
- **Port**: 3000 (configurable via .env)
- **Auto-restart**: Enabled with 10-second delay
- **Security**: Enhanced security restrictions enabled

### Environment Variables

Key environment variables in `/opt/ihub-apps/.env`:

```bash
# Server configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# API Keys (configure as needed)
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_key
MISTRAL_API_KEY=your_mistral_key

# Authentication (configure as needed)
AUTH_MODE=proxy
PROXY_AUTH_ENABLED=true
```

### File Permissions

The service has restricted file system access for security:

- **Read-only**: Most system directories
- **Read-write**: `/opt/ihub-apps/data` and `/opt/ihub-apps/contents`
- **Private**: `/tmp` directory

## Customization

### Port Configuration

To change the port:

1. Edit `/opt/ihub-apps/.env`:
   ```bash
   PORT=8080
   ```

2. If using a port < 1024, grant capability:
   ```bash
   # Find your node executable path first
   which node
   # Then grant the capability (example paths)
   sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node
   # Or if node is in /usr/local/bin:
   sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/node
   ```

3. Restart the service:
   ```bash
   sudo systemctl restart ihub-apps
   ```

### Resource Limits

The service includes resource limits:

- **File descriptors**: 65,536
- **Processes**: 4,096
- **Memory**: Limited by system

To adjust limits, edit `/etc/systemd/system/ihub-apps.service` and modify the `Limit*` directives.

### Worker Processes

Configure worker processes in `.env`:

```bash
# Number of worker processes (default: 1)
WORKERS=4
```

## Troubleshooting

### Service Won't Start

1. Check service status:
   ```bash
   sudo systemctl status ihub-apps
   ```

2. Check logs for errors:
   ```bash
   sudo journalctl -u ihub-apps --no-pager
   ```

3. Verify file permissions:
   ```bash
   ls -la /opt/ihub-apps/
   ```

### Permission Issues

1. Ensure correct ownership:
   ```bash
   sudo chown -R ihub-apps:ihub-apps /opt/ihub-apps
   ```

2. Check data directory permissions:
   ```bash
   sudo chmod 755 /opt/ihub-apps/data
   ```

### Node.js Issues

1. Verify Node.js version:
   ```bash
   node --version
   # Should be 20.0.0 or higher
   ```

2. Test application manually:
   ```bash
   sudo -u ihub-apps bash
   cd /opt/ihub-apps
   node -r dotenv/config server/server.js dotenv_config_path=.env
   ```

### Network Issues

1. Check if port is in use:
   ```bash
   sudo netstat -tlnp | grep 3000
   ```

2. Verify firewall settings:
   ```bash
   # For UFW
   sudo ufw allow 3000
   
   # For firewalld
   sudo firewall-cmd --permanent --add-port=3000/tcp
   sudo firewall-cmd --reload
   ```

## Security Considerations

The service file includes several security features:

- **User isolation**: Runs as dedicated system user
- **File system restrictions**: Limited write access
- **System call filtering**: Restricts dangerous system calls
- **Network restrictions**: Limited address families
- **Memory protections**: Prevents executable memory

For production deployments, consider:

- Using a reverse proxy (nginx, Apache)
- Setting up SSL/TLS certificates
- Configuring firewall rules
- Regular security updates

## Uninstallation

To remove the service:

```bash
# Stop and disable service
sudo systemctl stop ihub-apps
sudo systemctl disable ihub-apps

# Remove service file
sudo rm /etc/systemd/system/ihub-apps.service

# Reload systemd
sudo systemctl daemon-reload

# Remove application directory (optional)
sudo rm -rf /opt/ihub-apps

# Remove system user (optional)
sudo userdel ihub-apps
```