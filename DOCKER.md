# Docker Support for AI Hub Apps

This document provides comprehensive guidance for running AI Hub Apps in containerized environments including Docker, Kubernetes, and OpenShift.

## Quick Start

### Docker

1. **Build the image locally:**

   ```bash
   docker build -t ai-hub-apps .
   ```

2. **Run with Docker Compose:**

   ```bash
   # Set your API keys in .env file or environment variables
   export OPENAI_API_KEY="your-key"
   export ANTHROPIC_API_KEY="your-key"
   export GOOGLE_API_KEY="your-key"

   docker-compose up -d
   ```

3. **Access the application:**
   - Open http://localhost:3000

### Kubernetes

1. **Deploy to Kubernetes:**

   ```bash
   # Apply all manifests
   kubectl apply -k kubernetes/

   # Or apply individually
   kubectl apply -f kubernetes/
   ```

2. **Configure secrets:**
   ```bash
   # Update the secret with your API keys
   kubectl edit secret ai-hub-apps-secrets -n ai-hub-apps
   ```

## Docker Image

### Base Image

- Uses AWS hardened base image: `public.ecr.aws/amazonlinux/amazonlinux:2023`
- Node.js 20+ for Single Executable Application (SEA) support
- Non-root user for security

### Image Features

- **Multi-architecture**: Supports both `linux/amd64` and `linux/arm64`
- **Binary execution**: Attempts to use compiled binary, falls back to Node.js
- **Security hardened**: Runs as non-root user (uid: 1000)
- **Health checks**: Built-in health endpoint monitoring
- **Volume mounts**: External configuration, logs, and data persistence

### Environment Variables

| Variable            | Description         | Default                | Required |
| ------------------- | ------------------- | ---------------------- | -------- |
| `NODE_ENV`          | Node.js environment | `production`           | No       |
| `PORT`              | Application port    | `3000`                 | No       |
| `OPENAI_API_KEY`    | OpenAI API key      | -                      | Yes\*    |
| `ANTHROPIC_API_KEY` | Anthropic API key   | -                      | Yes\*    |
| `GOOGLE_API_KEY`    | Google API key      | -                      | Yes\*    |
| `MISTRAL_API_KEY`   | Mistral API key     | -                      | Yes\*    |
| `CONFIG_PATH`       | Configuration path  | `/app/contents/config` | No       |
| `LOGS_PATH`         | Logs directory path | `/app/logs`            | No       |
| `DATA_PATH`         | Data directory path | `/app/data`            | No       |

\*At least one API key is required for the application to function.

### Volume Mounts

| Path                   | Description                     | Type       |
| ---------------------- | ------------------------------- | ---------- |
| `/app/contents/config` | Application configuration files | Read-only  |
| `/app/contents/models` | LLM model configurations        | Read-only  |
| `/app/contents/apps`   | App definitions                 | Read-only  |
| `/app/contents/pages`  | Custom pages                    | Read-only  |
| `/app/logs`            | Application logs                | Read-write |
| `/app/data`            | Persistent application data     | Read-write |

## Deployment Options

### 1. Docker Compose (Development)

```yaml
version: '3.8'
services:
  ai-hub-apps:
    image: ghcr.io/intrafind/ai-hub-apps:latest
    ports:
      - '3000:3000'
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./contents/config:/app/contents/config:ro
      - logs-volume:/app/logs
      - data-volume:/app/data
volumes:
  logs-volume:
  data-volume:
```

### 2. Kubernetes (Production)

```bash
# Deploy all resources
kubectl apply -k kubernetes/

# Check deployment status
kubectl get pods -n ai-hub-apps

# Access via port-forward (for testing)
kubectl port-forward svc/ai-hub-apps 3000:80 -n ai-hub-apps
```

### 3. OpenShift

```bash
# Create new project
oc new-project ai-hub-apps

# Apply manifests (OpenShift Route is included)
oc apply -f kubernetes/

# Get route URL
oc get route ai-hub-apps -n ai-hub-apps
```

### 4. Amazon EKS

```bash
# Use AWS Load Balancer Controller for ingress
kubectl apply -f kubernetes/
kubectl annotate service ai-hub-apps -n ai-hub-apps \
  service.beta.kubernetes.io/aws-load-balancer-type=nlb
```

### 5. Google GKE

```bash
# Deploy with GKE ingress
kubectl apply -f kubernetes/
kubectl annotate ingress ai-hub-apps -n ai-hub-apps \
  kubernetes.io/ingress.class=gce
```

### 6. Azure AKS

```bash
# Use Azure Application Gateway
kubectl apply -f kubernetes/
kubectl annotate ingress ai-hub-apps -n ai-hub-apps \
  kubernetes.io/ingress.class=azure/application-gateway
```

## Configuration Management

### External Configuration

Mount your configuration files externally to customize the application:

```bash
# Docker
docker run -v /host/config:/app/contents/config:ro ai-hub-apps

# Kubernetes ConfigMap
kubectl create configmap ai-hub-config --from-file=./config/
```

### Secrets Management

#### Docker Secrets

```bash
echo "your-api-key" | docker secret create openai_key -
docker service create --secret openai_key ai-hub-apps
```

#### Kubernetes Secrets

```bash
kubectl create secret generic ai-hub-apps-secrets \
  --from-literal=OPENAI_API_KEY=your-key \
  --from-literal=ANTHROPIC_API_KEY=your-key \
  -n ai-hub-apps
```

#### External Secret Operators

- AWS Secrets Manager
- Azure Key Vault
- Google Secret Manager
- HashiCorp Vault

## Monitoring and Observability

### Health Checks

- **Endpoint**: `GET /api/health`
- **Response**: `200 OK` when healthy
- **Kubernetes**: Automatically configured liveness/readiness probes

### Logging

- **Format**: JSON structured logs (production)
- **Location**: `/app/logs` (mounted volume)
- **Rotation**: Handled by container runtime

### Metrics

- **Endpoint**: `/metrics` (if enabled)
- **Format**: Prometheus format
- **Kubernetes**: Annotated for automatic scraping

## Security Considerations

### Container Security

- **Non-root user**: Runs as uid 1000
- **Read-only filesystem**: Minimal write access
- **Dropped capabilities**: All unnecessary capabilities removed
- **Security scanning**: Trivy vulnerability scanning in CI/CD

### Network Security

- **Ingress**: HTTPS/TLS termination
- **CORS**: Configurable cross-origin policies
- **Rate limiting**: Built-in request throttling

### Data Security

- **Secrets**: External secret management recommended
- **Encryption**: TLS in transit, volume encryption at rest
- **Access control**: Kubernetes RBAC policies

## Scaling and Performance

### Horizontal Pod Autoscaler (HPA)

```yaml
# Scales between 2-10 pods based on CPU/memory
kubectl apply -f kubernetes/hpa.yaml
```

### Vertical Pod Autoscaler (VPA)

```bash
# Automatically adjusts resource requests/limits
kubectl apply -f https://github.com/kubernetes/autoscaler/releases/download/vertical-pod-autoscaler-0.13.0/vpa-release.yaml
```

### Resource Recommendations

- **CPU**: 500m request, 2000m limit
- **Memory**: 512Mi request, 2Gi limit
- **Storage**: 10Gi logs, 20Gi data

## Troubleshooting

### Common Issues

1. **Container won't start**

   ```bash
   # Check logs
   docker logs ai-hub-apps
   kubectl logs -f deployment/ai-hub-apps -n ai-hub-apps
   ```

2. **Health check failures**

   ```bash
   # Test health endpoint
   curl http://localhost:3000/api/health
   ```

3. **Permission errors**

   ```bash
   # Check file permissions
   ls -la /app/logs /app/data
   ```

4. **API key errors**
   ```bash
   # Verify secrets
   kubectl get secret ai-hub-apps-secrets -o yaml -n ai-hub-apps
   ```

### Debug Mode

```bash
# Enable debug logging
docker run -e DEBUG=* -e LOG_LEVEL=debug ai-hub-apps
```

## CI/CD Integration

### GitHub Actions

The repository includes automated Docker image building and publishing:

- **Triggers**: Push to main/develop, tags, PRs
- **Registry**: GitHub Container Registry (ghcr.io)
- **Security**: Trivy vulnerability scanning
- **Platforms**: linux/amd64, linux/arm64

### Image Tags

- `latest`: Latest stable release
- `v1.0.5`: Specific version
- `main`: Latest main branch
- `develop`: Latest development branch

## Support

For issues, questions, or contributions:

- **GitHub Issues**: [Repository Issues](https://github.com/intrafind/ai-hub-apps/issues)
- **Documentation**: [Project Docs](./docs/)
- **Security**: Report security issues privately

## License

This project is licensed under the terms specified in the LICENSE file.
