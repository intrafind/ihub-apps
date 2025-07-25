# AI Hub Apps - Docker and Kubernetes Deployment Guide

This directory contains deployment configurations for AI Hub Apps across different container orchestration platforms including Docker, Kubernetes, OpenShift, and Helm charts.

## Prerequisites

- Docker 20.04+
- Kubernetes 1.24+
- Helm 3.8+ (for Helm deployments)
- kubectl configured for your cluster

## Quick Start

### Docker Deployment

1. **Build the Docker image:**

   ```bash
   docker build -t ai-hub-apps:latest .
   ```

2. **Run with Docker Compose:**

   ```bash
   # Copy and edit environment variables
   cp .env.example .env

   # Start the application
   docker-compose up -d
   ```

3. **Access the application:**
   ```
   http://localhost:3000
   ```

### Kubernetes Deployment

1. **Apply the manifests:**

   ```bash
   # Create namespace and basic resources
   kubectl apply -f deployments/kubernetes/secrets-and-storage.yaml
   kubectl apply -f deployments/kubernetes/configmap.yaml

   # Deploy the application
   kubectl apply -f deployments/kubernetes/deployment.yaml
   kubectl apply -f deployments/kubernetes/ingress.yaml
   ```

2. **Configure secrets:**
   ```bash
   # Create secrets with your API keys
   kubectl create secret generic ai-hub-secrets \
     --namespace=ai-hub \
     --from-literal=openai-api-key="your-openai-key" \
     --from-literal=anthropic-api-key="your-anthropic-key" \
     --from-literal=google-api-key="your-google-key" \
     --from-literal=jwt-secret="your-jwt-secret"
   ```

## Deployment Options

### 1. Docker Standalone

**Basic Docker Run:**

```bash
docker run -d \
  --name ai-hub-apps \
  -p 3000:3000 \
  -e OPENAI_API_KEY="your-key" \
  -e ANTHROPIC_API_KEY="your-key" \
  -v $(pwd)/docker/config:/app/config:ro \
  -v ai-hub-data:/app/data \
  -v ai-hub-logs:/app/logs \
  ghcr.io/intrafind/ai-hub-apps:latest
```

**With External Configuration:**

```bash
# Create configuration directory
mkdir -p ./docker/config

# Copy default configurations and customize
cp contents/config/*.json ./docker/config/

# Run with external config
docker run -d \
  --name ai-hub-apps \
  -p 3000:3000 \
  -v $(pwd)/docker/config:/app/config:ro \
  -v ai-hub-data:/app/data \
  -v ai-hub-logs:/app/logs \
  --env-file .env \
  ghcr.io/intrafind/ai-hub-apps:latest
```

### 2. Docker Compose

The `docker-compose.yml` file provides a complete setup with:

- External configuration mapping
- Persistent data volumes
- Log aggregation
- Health checks
- Security hardening

**Development Mode:**

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

**Production Mode:**

```bash
docker-compose up -d
```

### 3. Kubernetes

#### Standard Kubernetes

Deploy to any Kubernetes cluster (EKS, GKE, AKS, on-premises):

```bash
# Create namespace
kubectl create namespace ai-hub

# Apply all manifests
kubectl apply -f deployments/kubernetes/
```

#### Environment-Specific Examples

**AWS EKS:**

```bash
# Use AWS Load Balancer Controller
kubectl apply -f deployments/kubernetes/deployment.yaml
kubectl apply -f deployments/kubernetes/ingress.yaml  # Uses ALB annotations
```

**Google GKE:**

```bash
# Use Google Cloud Load Balancer
kubectl apply -f deployments/kubernetes/
# Update ingress.yaml to use gce ingress class
```

**Azure AKS:**

```bash
# Use Azure Application Gateway
kubectl apply -f deployments/kubernetes/
# Update ingress.yaml for Azure-specific annotations
```

### 4. OpenShift

OpenShift deployment with Routes and security contexts:

```bash
# Create project
oc new-project ai-hub

# Apply OpenShift-specific manifests
oc apply -f deployments/openshift/
```

### 5. Helm Chart

Deploy using Helm for easier configuration management:

```bash
# Add custom values
cp deployments/helm/ai-hub-apps/values.yaml my-values.yaml

# Install
helm install ai-hub-apps deployments/helm/ai-hub-apps/ \
  -f my-values.yaml \
  --namespace ai-hub \
  --create-namespace

# Upgrade
helm upgrade ai-hub-apps deployments/helm/ai-hub-apps/ \
  -f my-values.yaml
```

## Configuration

### Environment Variables

| Variable            | Description             | Required | Default       |
| ------------------- | ----------------------- | -------- | ------------- |
| `NODE_ENV`          | Runtime environment     | No       | `production`  |
| `PORT`              | Application port        | No       | `3000`        |
| `LOG_LEVEL`         | Logging level           | No       | `info`        |
| `OPENAI_API_KEY`    | OpenAI API key          | No       | -             |
| `ANTHROPIC_API_KEY` | Anthropic API key       | No       | -             |
| `GOOGLE_API_KEY`    | Google API key          | No       | -             |
| `MISTRAL_API_KEY`   | Mistral API key         | No       | -             |
| `JWT_SECRET`        | JWT signing secret      | Yes      | -             |
| `CONFIG_DIR`        | Configuration directory | No       | `/app/config` |
| `DATA_DIR`          | Data directory          | No       | `/app/data`   |
| `LOG_DIR`           | Log directory           | No       | `/app/logs`   |

### External Configuration

#### Volume Mounts

- **Configuration**: `/app/config` - Mount your custom JSON config files
- **Data**: `/app/data` - Persistent application data
- **Logs**: `/app/logs` - Application logs for external aggregation

#### Configuration Files

Override default configurations by mounting files to `/app/config/`:

- `platform.json` - Server and authentication settings
- `apps.json` - AI application definitions
- `models.json` - LLM model configurations
- `groups.json` - User groups and permissions
- `ui.json` - UI customization and branding

## Security Considerations

### Container Security

- **Non-root user**: Containers run as user ID 1000
- **Read-only filesystem**: Root filesystem is read-only
- **Minimal attack surface**: Based on hardened AWS Linux images
- **No privileged access**: Containers drop all capabilities

### Kubernetes Security

- **Network policies**: Restrict ingress/egress traffic
- **Pod security contexts**: Enforce security constraints
- **RBAC**: Minimal service account permissions
- **Secrets management**: API keys stored in Kubernetes secrets

### Secret Management

**Kubernetes Secrets:**

```bash
# Create secrets from literal values
kubectl create secret generic ai-hub-secrets \
  --from-literal=openai-api-key="sk-..." \
  --from-literal=jwt-secret="your-32-char-secret"

# Or from files
kubectl create secret generic ai-hub-secrets \
  --from-file=openai-api-key=./openai-key.txt
```

**External Secrets (recommended for production):**

```yaml
# Using external-secrets operator
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ai-hub-secrets
spec:
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: ai-hub-secrets
  data:
    - secretKey: openai-api-key
      remoteRef:
        key: ai-hub/openai-api-key
```

## Monitoring and Observability

### Health Checks

The application provides health endpoints:

- `GET /api/health` - Basic health check
- Container health checks configured in all deployment options

### Logging

Structured JSON logging is enabled by default. Logs are written to:

- **Console**: For container log aggregation
- **Files**: `/app/logs/` directory (if mounted)

### Metrics

Enable Prometheus metrics by setting environment variables:

```bash
ENABLE_METRICS=true
METRICS_PORT=9090
```

## Scaling and Performance

### Horizontal Scaling

**Kubernetes:**

```bash
# Scale manually
kubectl scale deployment ai-hub-apps --replicas=5

# Enable HPA
kubectl autoscale deployment ai-hub-apps \
  --cpu-percent=70 \
  --min=2 \
  --max=10
```

**Docker Swarm:**

```bash
docker service scale ai-hub-apps=5
```

### Resource Requirements

**Minimum:**

- CPU: 250m
- Memory: 512Mi

**Recommended:**

- CPU: 500m
- Memory: 1Gi

**High Load:**

- CPU: 1000m
- Memory: 2Gi

## Troubleshooting

### Common Issues

1. **Container won't start:**

   ```bash
   # Check logs
   docker logs ai-hub-apps
   kubectl logs deployment/ai-hub-apps
   ```

2. **Permission errors:**

   ```bash
   # Ensure proper ownership
   chown -R 1000:1000 /path/to/data
   ```

3. **Configuration issues:**
   ```bash
   # Validate JSON configuration
   cat platform.json | jq .
   ```

### Debug Mode

Enable debug logging:

```bash
# Docker
docker run -e LOG_LEVEL=debug ...

# Kubernetes
kubectl set env deployment/ai-hub-apps LOG_LEVEL=debug
```

## Support

For deployment issues:

1. Check the logs for error messages
2. Verify configuration files are valid JSON
3. Ensure all required environment variables are set
4. Check resource quotas and limits
5. Validate network connectivity to LLM providers

## Migration from Previous Versions

When upgrading:

1. Backup your configuration and data volumes
2. Update the image tag
3. Apply any new configuration changes
4. Test the deployment in a staging environment first

## Platform-Specific Notes

### AWS EKS

- Use `gp2` or `gp3` storage classes
- Configure ALB ingress controller
- Consider using IAM roles for service accounts (IRSA)

### Google GKE

- Use `standard` or `ssd` storage classes
- Enable workload identity for secret access
- Configure GCE ingress controller

### Azure AKS

- Use `managed-premium` storage class
- Configure Application Gateway ingress
- Use Azure Key Vault for secrets

### OpenShift

- Uses Routes instead of Ingress
- Automatic security context assignment
- Built-in image registry support
