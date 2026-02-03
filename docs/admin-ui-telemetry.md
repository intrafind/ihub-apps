# Admin UI: Telemetry Configuration

**Last Updated:** 2026-01-21  
**For:** Administrators using the iHub Admin UI

---

## Accessing Telemetry Configuration

### Via Admin UI

1. **Log in to Admin Panel**
   - Navigate to: `http://your-ihub-server:3000/admin`
   - Use admin credentials

2. **Navigate to Configuration**
   - Click "Configuration" in the sidebar
   - Select "Platform Configuration"

3. **Find Telemetry Section**
   - Scroll to `telemetry` object
   - Modify settings as needed

4. **Save Changes**
   - Click "Save" button
   - Configuration applies immediately (no restart required for most changes)

---

## Configuration via Admin API

### Get Current Telemetry Config

```bash
GET /admin/configs/platform
Authorization: Bearer YOUR_ADMIN_TOKEN
```

Response:
```json
{
  "telemetry": {
    "enabled": false,
    "provider": "console",
    "spans": { "enabled": true },
    "metrics": { "enabled": true }
  }
}
```

### Update Telemetry Config

```bash
PUT /admin/configs/platform
Authorization: Bearer YOUR_ADMIN_TOKEN
Content-Type: application/json

{
  "telemetry": {
    "enabled": true,
    "provider": "prometheus",
    "exporters": {
      "prometheus": {
        "port": 9464
      }
    }
  }
}
```

---

## Runtime Configuration Changes

### Changes That Apply Immediately

✅ **No Restart Required:**
- Enabling/disabling telemetry
- Changing span sampling rate
- Enabling/disabling events
- Changing metric export interval
- Modifying privacy settings (includePrompts, includeCompletions)

### Changes That Require Restart

⚠️ **Restart Required:**
- Changing exporter type (console → otlp → prometheus)
- Modifying OTLP endpoint URL
- Changing Prometheus port
- Updating service name/version

**To restart:**
```bash
npm run server
# or
systemctl restart ihub-apps
```

---

## Common Configuration Scenarios

### Enable Basic Telemetry

**Use Case:** Start monitoring without external tools

**Configuration:**
```json
{
  "telemetry": {
    "enabled": true,
    "provider": "console"
  }
}
```

**Result:** Metrics logged to server console

---

### Enable Prometheus Metrics

**Use Case:** Export metrics to Prometheus

**Configuration:**
```json
{
  "telemetry": {
    "enabled": true,
    "provider": "prometheus",
    "exporters": {
      "prometheus": {
        "port": 9464,
        "host": "0.0.0.0"
      }
    },
    "metrics": {
      "enabled": true
    }
  }
}
```

**Verify:**
```bash
curl http://localhost:9464/metrics
```

**Restart:** Required (port binding change)

---

### Enable Distributed Tracing

**Use Case:** Send traces to Jaeger/Grafana Cloud

**Configuration:**
```json
{
  "telemetry": {
    "enabled": true,
    "provider": "otlp",
    "exporters": {
      "otlp": {
        "endpoint": "http://localhost:4318",
        "headers": {}
      }
    },
    "spans": {
      "enabled": true
    }
  }
}
```

**Restart:** Required (exporter change)

---

### Reduce Performance Impact

**Use Case:** Lower overhead for high-traffic deployments

**Configuration:**
```json
{
  "telemetry": {
    "enabled": true,
    "spans": {
      "sampleRate": 0.1
    },
    "events": {
      "enabled": false
    },
    "metrics": {
      "exportInterval": 120000
    }
  }
}
```

**Restart:** Not required (runtime adjustable)

---

### Debug Mode (Development Only)

**Use Case:** Full visibility for debugging

⚠️ **WARNING: Never use in production - logs sensitive data**

**Configuration:**
```json
{
  "telemetry": {
    "enabled": true,
    "provider": "console",
    "events": {
      "enabled": true,
      "includePrompts": true,
      "includeCompletions": true
    },
    "spans": {
      "includeOptInAttributes": true
    }
  }
}
```

**Restart:** Not required

---

## Monitoring Telemetry Status

### Check if Telemetry is Enabled

```bash
curl http://localhost:3000/api/health
```

Response includes telemetry status:
```json
{
  "status": "healthy",
  "telemetry": {
    "enabled": true,
    "provider": "prometheus",
    "metricsEndpoint": "http://localhost:9464/metrics"
  }
}
```

### View Metrics (Prometheus)

```bash
curl http://localhost:9464/metrics | grep ihub
```

Expected output:
```
ihub_app_usage_total{app_id="chat"} 42
ihub_conversations_total{conversation_is_follow_up="true"} 28
gen_ai_client_token_usage_sum{gen_ai_token_type="input"} 15234
```

---

## Troubleshooting

### Telemetry Not Working

1. **Check configuration file:**
```bash
cat contents/config/platform.json | jq .telemetry
```

2. **Verify server logs:**
```bash
npm run logs | grep -i telemetry
```

Look for:
- "Initializing telemetry..."
- "GenAI metrics initialized successfully"

3. **Test manually:**
```bash
# Make a chat request
curl -X POST http://localhost:3000/api/... 

# Check metrics
curl http://localhost:9464/metrics | grep ihub
```

### Configuration Not Saving

1. **Check admin permissions:**
   - Ensure user has admin access
   - Verify JWT token is valid

2. **Check file permissions:**
```bash
ls -la contents/config/platform.json
# Should be writable by server process
```

3. **Check server logs for errors:**
```bash
npm run logs | grep -i "error"
```

### Metrics Port Already in Use

**Error:** `EADDRINUSE: address already in use :::9464`

**Solution:**
```json
{
  "telemetry": {
    "exporters": {
      "prometheus": {
        "port": 9465
      }
    }
  }
}
```

**Note:** Requires server restart

---

## Best Practices

### Production Configuration

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "otlp",
    "exporters": {
      "otlp": {
        "endpoint": "https://your-observability-backend.com",
        "headers": {
          "authorization": "Bearer ${TELEMETRY_API_KEY}"
        }
      }
    },
    "spans": {
      "enabled": true,
      "sampleRate": 0.1,
      "includeOptInAttributes": false
    },
    "events": {
      "enabled": true,
      "includePrompts": false,
      "includeCompletions": false
    },
    "metrics": {
      "enabled": true,
      "exportInterval": 60000
    }
  }
}
```

### Development Configuration

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "console",
    "spans": {
      "enabled": true,
      "sampleRate": 1.0
    },
    "metrics": {
      "enabled": true
    }
  }
}
```

### Staging Configuration

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "prometheus",
    "spans": {
      "sampleRate": 0.5
    },
    "events": {
      "includePrompts": true,
      "includeCompletions": true
    }
  }
}
```

---

## Security Considerations

### Environment Variables for Secrets

Instead of storing API tokens in platform.json:

```json
{
  "telemetry": {
    "exporters": {
      "otlp": {
        "headers": {
          "authorization": "${TELEMETRY_API_KEY}"
        }
      }
    }
  }
}
```

Set in `.env`:
```bash
TELEMETRY_API_KEY="Bearer your-secret-token"
```

### Restrict Admin Access

Ensure only authorized users can modify telemetry configuration:

1. **Check groups configuration** (`contents/config/groups.json`)
2. **Verify admin group has restricted membership**
3. **Review admin access logs**

---

## Next Steps

1. **Enable telemetry** via admin UI
2. **Verify metrics** are being exported
3. **Set up dashboards** in Grafana
4. **Create alerts** for critical metrics
5. **Monitor performance** impact

---

**Related Documentation:**
- [Telemetry Configuration Guide](./admin-telemetry-guide.md)
- [Grafana Dashboards](./grafana-dashboards.md)
- [Metrics Reference](./metrics-reference.md)
