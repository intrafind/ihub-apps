# Kerberos Authentication Configuration Examples

This document provides practical configuration examples for implementing Kerberos authentication with NTLM fallback in iHub Apps.

## Phase 1: Basic Implementation (express-ntlm negotiate)

### Platform Configuration

Update your `contents/config/platform.json`:

```json
{
  "auth": {
    "mode": "ntlm",
    "authenticatedGroup": "authenticated",
    "sessionTimeoutMinutes": 480,
    "jwtSecret": "your-jwt-secret"
  },
  "ntlmAuth": {
    "enabled": true,
    "type": "negotiate",
    "domain": "YOURDOMAIN.COM",
    "domainController": "dc1.yourdomain.com",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "generateJwtToken": true,
    "sessionTimeoutMinutes": 480,
    "defaultGroups": ["authenticated", "domain-users"],
    "name": "Windows Domain",
    "options": {
      "tlsOptions": {
        "rejectUnauthorized": false
      }
    }
  }
}
```

### Environment Variables

```bash
# .env file
NODE_ENV=production
DOMAIN_CONTROLLER=dc1.yourdomain.com
KERBEROS_REALM=YOURDOMAIN.COM
SERVICE_ACCOUNT_PASSWORD=your-service-password

# Optional: Enhanced logging
NTLM_DEBUG=false
AUTH_DEBUG=true
```

### Group Mapping Configuration

Update your `contents/config/groups.json`:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Administrators",
      "description": "Full administrative access",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": [
        "YOURDOMAIN\\Domain Admins",
        "YOURDOMAIN\\iHub Admins",
        "Domain Admins",
        "iHub Admins"
      ]
    },
    "power-users": {
      "id": "power-users",
      "name": "Power Users",
      "description": "Extended access for power users",
      "inherits": ["users"],
      "permissions": {
        "apps": ["analysis", "research", "reporting"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-3"]
      },
      "mappings": [
        "YOURDOMAIN\\iHub Power Users",
        "iHub Power Users"
      ]
    },
    "users": {
      "id": "users",
      "name": "Standard Users",
      "description": "Standard user access",
      "inherits": ["authenticated"],
      "permissions": {
        "apps": ["basic-chat", "document-review"],
        "models": ["gpt-3.5-turbo", "claude-instant"]
      },
      "mappings": [
        "YOURDOMAIN\\Domain Users",
        "Domain Users"
      ]
    },
    "authenticated": {
      "id": "authenticated",
      "name": "Authenticated Users",
      "description": "Base permissions for all authenticated users",
      "permissions": {
        "apps": [],
        "models": []
      }
    }
  }
}
```

## Phase 2: Enhanced Implementation (node-expose-sspi)

### Enhanced Configuration Schema

```json
{
  "kerberosAuth": {
    "enabled": true,
    "provider": "sspi",
    "domain": "YOURDOMAIN.COM",
    "domainController": "dc1.yourdomain.com",
    "spn": "HTTP/ihub.yourdomain.com",
    "realm": "YOURDOMAIN.COM",
    "debug": false,
    "features": {
      "sidResolution": true,
      "nestedGroups": true,
      "userAttributes": true,
      "tokenGroups": true,
      "extendedProperties": true
    },
    "fallback": {
      "ntlm": true,
      "anonymous": false,
      "timeout": 30000
    },
    "security": {
      "allowDelegation": false,
      "requireMutualAuth": true,
      "clockSkewMinutes": 5,
      "encryptionTypes": [
        "AES256-CTS-HMAC-SHA1-96",
        "AES128-CTS-HMAC-SHA1-96"
      ]
    },
    "performance": {
      "connectionPool": {
        "maxConnections": 10,
        "keepAlive": true,
        "timeout": 5000
      },
      "userCache": {
        "enabled": true,
        "ttlMinutes": 15,
        "maxEntries": 1000
      },
      "groupCache": {
        "enabled": true,
        "ttlMinutes": 30,
        "maxEntries": 500
      }
    },
    "attributes": {
      "retrieve": [
        "department",
        "title",
        "manager",
        "telephoneNumber",
        "mail",
        "memberOf"
      ],
      "mapping": {
        "department": "department",
        "title": "jobTitle",
        "manager": "managerDN",
        "telephoneNumber": "phone",
        "mail": "email"
      }
    }
  }
}
```

### Service Principal Name (SPN) Setup

```bash
# Windows Domain Controller Commands
# Run as Domain Administrator

# Register SPN for the service account
setspn -A HTTP/ihub.yourdomain.com YOURDOMAIN\ihub-service

# Verify SPN registration
setspn -L YOURDOMAIN\ihub-service

# Generate keytab for Linux/Unix servers (optional)
ktpass -princ HTTP/ihub.yourdomain.com@YOURDOMAIN.COM ^
       -mapuser ihub-service@YOURDOMAIN.COM ^
       -crypto AES256-SHA1 ^
       -ptype KRB5_NT_PRINCIPAL ^
       -pass your-service-password ^
       -out ihub.keytab
```

### DNS Configuration

```bash
# DNS A Record
ihub.yourdomain.com    IN  A   192.168.1.100

# DNS PTR Record (Reverse lookup)
100.1.168.192.in-addr.arpa. IN PTR ihub.yourdomain.com.

# SRV Records for Kerberos
_kerberos._tcp.yourdomain.com.     IN SRV 0 5 88  dc1.yourdomain.com.
_kerberos._udp.yourdomain.com.     IN SRV 0 5 88  dc1.yourdomain.com.
_kerberos-master._tcp.yourdomain.com. IN SRV 0 5 88  dc1.yourdomain.com.
_kpasswd._tcp.yourdomain.com.      IN SRV 0 5 464 dc1.yourdomain.com.
```

## Browser Configuration

### Chrome Enterprise Policy

```json
{
  "AuthServerWhitelist": "*.yourdomain.com",
  "AuthNegotiateDelegateWhitelist": "*.yourdomain.com",
  "AuthSchemes": "basic,digest,ntlm,negotiate",
  "DisableAuthNegotiateCnameLookup": false,
  "EnableAuthNegotiatePort": false,
  "AuthAndroidNegotiateAccountType": "",
  "AuthServerAllowlist": "*.yourdomain.com"
}
```

### Windows Registry for Chrome/Edge

```registry
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome]
"AuthServerWhitelist"="*.yourdomain.com"
"AuthNegotiateDelegateWhitelist"="*.yourdomain.com"
"AuthSchemes"="basic,digest,ntlm,negotiate"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge]
"AuthServerWhitelist"="*.yourdomain.com"
"AuthNegotiateDelegateWhitelist"="*.yourdomain.com"
```

### Firefox Configuration

Add to `firefox.cfg` or configure via `about:config`:

```javascript
// Firefox configuration
lockPref("network.negotiate-auth.trusted-uris", "https://ihub.yourdomain.com,https://.yourdomain.com");
lockPref("network.negotiate-auth.delegation-uris", "https://ihub.yourdomain.com");
lockPref("network.automatic-ntlm-auth.trusted-uris", "https://ihub.yourdomain.com,https://.yourdomain.com");
lockPref("network.negotiate-auth.allow-non-fqdn", true);
lockPref("network.negotiate-auth.allow-proxies", true);
```

## Security Configurations

### SSL/TLS Certificate Configuration

```bash
# Generate CSR for the service
openssl req -new -newkey rsa:4096 -nodes -keyout ihub.key -out ihub.csr \
  -subj "/C=US/ST=State/L=City/O=Organization/OU=IT/CN=ihub.yourdomain.com"

# Alternative: SAN certificate for multiple names
openssl req -new -newkey rsa:4096 -nodes -keyout ihub.key -out ihub.csr \
  -config <(cat <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req

[req_distinguished_name]
CN = ihub.yourdomain.com

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ihub.yourdomain.com
DNS.2 = ihub
DNS.3 = ihub.yourdomain.local
EOF
)
```

### Firewall Configuration

```bash
# Windows Firewall Rules
netsh advfirewall firewall add rule name="iHub Apps HTTP" dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="iHub Apps HTTPS" dir=in action=allow protocol=TCP localport=443
netsh advfirewall firewall add rule name="Kerberos TCP" dir=in action=allow protocol=TCP localport=88
netsh advfirewall firewall add rule name="Kerberos UDP" dir=in action=allow protocol=UDP localport=88

# Linux iptables rules
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 88 -j ACCEPT
iptables -A OUTPUT -p udp --dport 88 -j ACCEPT
```

## Testing Configurations

### Local Development Setup

```bash
# .env.development
NODE_ENV=development
DOMAIN_CONTROLLER=dc1.test.local
KERBEROS_REALM=TEST.LOCAL
NTLM_DEBUG=true
AUTH_DEBUG=true

# Test domain setup (for development)
NTLM_DOMAIN=TEST
NTLM_USERNAME=testuser
NTLM_PASSWORD=testpass123
```

### Test User Creation

```powershell
# PowerShell script to create test users
# Run on Domain Controller

New-ADUser -Name "Test User" -SamAccountName "testuser" -UserPrincipalName "testuser@yourdomain.com" -Enabled $true -PasswordNeverExpires $true -AccountPassword (ConvertTo-SecureString "TestPass123!" -AsPlainText -Force)

# Add to test groups
Add-ADGroupMember -Identity "iHub Users" -Members "testuser"
Add-ADGroupMember -Identity "Domain Users" -Members "testuser"

# Create service account
New-ADUser -Name "iHub Service" -SamAccountName "ihub-service" -UserPrincipalName "ihub-service@yourdomain.com" -Enabled $true -PasswordNeverExpires $true -AccountPassword (ConvertTo-SecureString "ServicePass123!" -AsPlainText -Force) -ServicePrincipalNames @("HTTP/ihub.yourdomain.com")

# Grant service account privileges
Grant-ADAuthenticationPolicySilo -Identity "ihub-service" -Silo "Kerberos-Only"
```

## Monitoring and Logging

### Enhanced Logging Configuration

```json
{
  "logging": {
    "level": "info",
    "kerberos": {
      "enabled": true,
      "level": "debug",
      "includeDetails": true,
      "maskSensitive": true
    },
    "authentication": {
      "enabled": true,
      "logSuccess": true,
      "logFailures": true,
      "includeUserAgent": true,
      "includeClientIP": true
    }
  }
}
```

### Metrics Configuration

```json
{
  "metrics": {
    "enabled": true,
    "authentication": {
      "successRate": true,
      "responseTime": true,
      "methodUsage": true,
      "fallbackRate": true,
      "errorTypes": true
    },
    "endpoints": {
      "/metrics": {
        "enabled": true,
        "requireAuth": true
      }
    }
  }
}
```

## Troubleshooting Configurations

### Debug Mode Configuration

```json
{
  "ntlmAuth": {
    "debug": true,
    "debugLevel": "verbose"
  },
  "authDebug": {
    "enabled": true,
    "maskTokens": false,
    "redactPasswords": true,
    "consoleLogging": true,
    "includeRawData": true,
    "providers": {
      "ntlm": {
        "enabled": true,
        "includeHeaders": true,
        "includeNegotiation": true
      }
    }
  }
}
```

### Health Check Endpoints

```json
{
  "healthChecks": {
    "kerberos": {
      "enabled": true,
      "endpoint": "/api/health/kerberos",
      "checks": [
        "domainController",
        "spnResolution",
        "keytabValid",
        "clockSkew",
        "dnsResolution"
      ]
    }
  }
}
```

## Production Deployment

### Docker Configuration

```dockerfile
# Dockerfile additions for Kerberos support
FROM node:18-alpine

# Install Kerberos dependencies
RUN apk add --no-cache krb5-dev krb5-libs

# Copy keytab file
COPY ihub.keytab /etc/krb5.keytab
RUN chmod 600 /etc/krb5.keytab

# Kerberos configuration
COPY krb5.conf /etc/krb5.conf

WORKDIR /app
COPY . .
RUN npm ci --production

EXPOSE 3000
CMD ["npm", "start"]
```

### Kubernetes Configuration

```yaml
# kerberos-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kerberos-config
data:
  krb5.conf: |
    [libdefaults]
        default_realm = YOURDOMAIN.COM
        dns_lookup_realm = true
        dns_lookup_kdc = true
        ticket_lifetime = 24h
        renew_lifetime = 7d
        forwardable = true

    [realms]
        YOURDOMAIN.COM = {
            kdc = dc1.yourdomain.com
            admin_server = dc1.yourdomain.com
            default_domain = yourdomain.com
        }

    [domain_realm]
        .yourdomain.com = YOURDOMAIN.COM
        yourdomain.com = YOURDOMAIN.COM

---
apiVersion: v1
kind: Secret
metadata:
  name: kerberos-keytab
type: Opaque
data:
  ihub.keytab: <base64-encoded-keytab>

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
spec:
  template:
    spec:
      containers:
      - name: ihub-apps
        image: ihub-apps:latest
        volumeMounts:
        - name: kerberos-config
          mountPath: /etc/krb5.conf
          subPath: krb5.conf
        - name: kerberos-keytab
          mountPath: /etc/krb5.keytab
          subPath: ihub.keytab
        env:
        - name: KRB5_CONFIG
          value: /etc/krb5.conf
      volumes:
      - name: kerberos-config
        configMap:
          name: kerberos-config
      - name: kerberos-keytab
        secret:
          secretName: kerberos-keytab
          defaultMode: 0600
```

### Load Balancer Configuration

```nginx
# nginx.conf for Kerberos
upstream ihub_backend {
    server ihub-app-1:3000;
    server ihub-app-2:3000;
    server ihub-app-3:3000;
}

server {
    listen 443 ssl http2;
    server_name ihub.yourdomain.com;

    ssl_certificate /etc/ssl/certs/ihub.crt;
    ssl_certificate_key /etc/ssl/private/ihub.key;

    # Preserve authentication headers
    proxy_set_header Authorization $http_authorization;
    proxy_pass_header Authorization;
    
    # Kerberos requires connection persistence
    proxy_set_header Connection "";
    proxy_http_version 1.1;

    location / {
        proxy_pass http://ihub_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Preserve authentication
        proxy_pass_request_headers on;
    }
}
```

This configuration reference provides all the practical examples needed to implement Kerberos authentication with NTLM fallback in various environments.