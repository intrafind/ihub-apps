# Platform Configuration

The optional `platform.json` file controls global platform behaviour. It is located under `contents/config`.

```json
{
  "features": {
    "usageTracking": true
  },
  "requestBodyLimitMB": 50,
  "telemetry": {
    "enabled": false,
    "metrics": true,
    "traces": true,
    "logs": true,
    "port": 9464
  }
}
```

* **features.usageTracking** – enables or disables recording of usage statistics in `contents/data/usage.json`.
* **requestBodyLimitMB** – maximum size of JSON request bodies in megabytes. Defaults to `50`.
* **telemetry** – configures OpenTelemetry integration. When enabled, metrics are exported via Prometheus on the configured port and traces/logs can be collected.
