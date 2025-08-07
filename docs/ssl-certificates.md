# Self-Signed SSL Certificate Handling

When iHub Apps needs to communicate with external services that use self-signed SSL certificates (such as internal APIs, local development servers, or enterprise services), Node.js will reject these connections by default for security reasons.

This guide covers how administrators can configure the application to work with self-signed certificates in different scenarios.

## Understanding the Problem

Node.js applications, including iHub Apps, use the system's certificate store to verify SSL/TLS connections. When connecting to a service with a self-signed certificate, you may encounter errors like:

```
Error: unable to verify the first certificate
Error: self signed certificate
Error: certificate verify failed
```

These errors occur when iHub Apps makes requests to:

- Custom LLM endpoints with self-signed certificates
- Internal APIs configured as tools
- Authentication providers (OIDC) using self-signed certificates
- Any external service called by the application

## Recommended Approach: Import Certificates

### Method 1: System Certificate Store (Recommended)

The most secure approach is to add your self-signed certificates to the system's trusted certificate store.

#### On Linux/Ubuntu:

```bash
# Copy your certificate to the certificates directory
sudo cp your-certificate.crt /usr/local/share/ca-certificates/

# Update the certificate store
sudo update-ca-certificates

# Restart iHub Apps
systemctl restart ihub-apps
```

#### On CentOS/RHEL:

```bash
# Copy your certificate
sudo cp your-certificate.crt /etc/pki/ca-trust/source/anchors/

# Update the certificate store
sudo update-ca-trust

# Restart iHub Apps
systemctl restart ihub-apps
```

#### On macOS:

```bash
# Add certificate to system keychain
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain your-certificate.crt

# Restart iHub Apps
```

#### On Windows:

1. Open the certificate file in Windows Explorer
2. Click "Install Certificate"
3. Choose "Local Machine" and place in "Trusted Root Certification Authorities"
4. Restart iHub Apps

### Method 2: Node.js Certificate Environment Variable

You can specify additional certificates for Node.js to trust:

```bash
# Set the path to your certificate file
export NODE_EXTRA_CA_CERTS=/path/to/your-certificate.pem

# Start iHub Apps
npm run start:prod
```

Or when running the binary:

```bash
NODE_EXTRA_CA_CERTS=/path/to/your-certificate.pem ./ihub-apps-v1.0.0-linux
```

### Method 3: Certificate Bundle

Create a certificate bundle containing your self-signed certificates:

```bash
# Create a bundle file
cat your-cert1.pem your-cert2.pem > custom-ca-bundle.pem

# Use the bundle
export NODE_EXTRA_CA_CERTS=/path/to/custom-ca-bundle.pem
```

## Alternative Approach: Disable Certificate Verification

> ⚠️ **Security Warning**: This approach disables SSL certificate verification entirely, making your application vulnerable to man-in-the-middle attacks. Use only in development or secure network environments.

### Environment Variable Method

Set the `NODE_TLS_REJECT_UNAUTHORIZED` environment variable to disable certificate verification:

```bash
# Disable SSL certificate verification (NOT RECOMMENDED for production)
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Start iHub Apps
npm run start:prod
```

Or when running the binary:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 ./ihub-apps-v1.0.0-linux
```

### Configuration File Method

Add the environment variable to your `config.env` file:

```env
# config.env
NODE_TLS_REJECT_UNAUTHORIZED=0
```

> ⚠️ **Important**: When using this method, ALL outbound HTTPS connections will skip certificate verification, not just the ones with self-signed certificates.

## Production Deployment Guidance

### Docker Deployments

When running iHub Apps in Docker containers:

#### Method 1: Mount Certificate Volume

```dockerfile
# In your Dockerfile or docker-compose.yml
COPY your-certificate.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates
```

Or with volume mount:

```yaml
# docker-compose.yml
services:
  ihub-apps:
    volumes:
      - ./certificates:/usr/local/share/ca-certificates:ro
    command: >
      sh -c "update-ca-certificates && npm run start:prod"
```

#### Method 2: Environment Variable in Docker

```yaml
# docker-compose.yml
services:
  ihub-apps:
    environment:
      - NODE_EXTRA_CA_CERTS=/app/certificates/bundle.pem
    volumes:
      - ./certificates/bundle.pem:/app/certificates/bundle.pem:ro
```

### Kubernetes Deployments

#### Using ConfigMaps for Certificates:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ca-certificates
data:
  bundle.pem: |
    -----BEGIN CERTIFICATE-----
    [Your certificate content here]
    -----END CERTIFICATE-----
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
          env:
            - name: NODE_EXTRA_CA_CERTS
              value: /etc/ssl/certs/bundle.pem
          volumeMounts:
            - name: ca-certs
              mountPath: /etc/ssl/certs/bundle.pem
              subPath: bundle.pem
      volumes:
        - name: ca-certs
          configMap:
            name: ca-certificates
```

### Load Balancer and Reverse Proxy Scenarios

If iHub Apps is behind a reverse proxy (nginx, Apache, etc.), you have additional options:

#### Option 1: Terminate SSL at Proxy

Configure your reverse proxy to handle SSL termination and communicate with backend services over HTTP or with proper certificates.

#### Option 2: Proxy Certificate Verification

Some reverse proxies can handle certificate verification on behalf of the backend application.

## Testing Your Configuration

After configuring certificate handling, test that external connections work:

### Test with curl

```bash
# Test the same endpoint that iHub Apps needs to reach
curl -v https://your-internal-api.example.com/health

# If using NODE_TLS_REJECT_UNAUTHORIZED=0, this should work:
NODE_TLS_REJECT_UNAUTHORIZED=0 curl -v https://your-internal-api.example.com/health
```

### Check iHub Apps Logs

Monitor the application logs for SSL-related errors:

```bash
# Check for SSL errors in logs
tail -f /var/log/ihub-apps/app.log | grep -i "certificate\|ssl\|tls"
```

### Test Specific Features

- Try using LLM models with custom endpoints
- Test authentication if using OIDC with self-signed certificates
- Verify any custom tools that make external API calls

## Security Considerations

### Certificate Validation Best Practices

1. **Always prefer importing certificates** over disabling verification
2. **Limit certificate scope** - only trust the specific certificates you need
3. **Regular certificate rotation** - update certificates before they expire
4. **Monitor certificate expiration** - set up alerts for expiring certificates
5. **Network isolation** - use self-signed certificates only in isolated network segments

### Risk Assessment

| Method                         | Security Level | Suitable For                |
| ------------------------------ | -------------- | --------------------------- |
| Import to system store         | High           | Production environments     |
| NODE_EXTRA_CA_CERTS            | High           | Production environments     |
| Certificate bundle             | High           | Container/cloud deployments |
| NODE_TLS_REJECT_UNAUTHORIZED=0 | Low            | Development only            |

## Troubleshooting

### Common Issues

#### Certificate Format Problems

Ensure certificates are in PEM format:

```bash
# Convert from DER to PEM if needed
openssl x509 -inform der -in certificate.der -out certificate.pem
```

#### Certificate Chain Issues

Include the full certificate chain if using intermediate certificates:

```bash
# Create full chain
cat server.crt intermediate.crt root.crt > fullchain.pem
```

#### Permission Issues

Ensure the application can read certificate files:

```bash
# Set appropriate permissions
chmod 644 /path/to/certificate.pem
chown root:root /path/to/certificate.pem
```

### Debug Certificate Issues

Enable Node.js TLS debugging:

```bash
# Enable detailed TLS debugging
export NODE_DEBUG=tls
npm run start:prod
```

This will show detailed information about certificate verification attempts.

### Verify Certificate Details

Check certificate information:

```bash
# View certificate details
openssl x509 -in certificate.pem -text -noout

# Check certificate validity
openssl x509 -in certificate.pem -checkend 86400
```

## Related Configuration

- [Server Configuration](server-config.md) - For configuring iHub Apps' own SSL certificates
- [External Authentication](external-authentication.md) - For OIDC providers with self-signed certificates

## Support

If you continue to experience issues with self-signed certificates:

1. Check the application logs for specific error messages
2. Verify certificate formats and validity
3. Test connections using curl with the same certificates
4. Consider consulting with your network security team for enterprise deployments
