# Security and Operations Guide for Containerized iHub Apps

**Document Version:** 1.0  
**Date:** 2025-07-28  
**Author:** Claude Code  
**Purpose:** Comprehensive security hardening and operational procedures for containerized deployments

## Security Framework

### Container Security Principles

#### 1. Least Privilege Access

- **Non-root containers**: All containers run as unprivileged user (UID 1000)
- **Read-only root filesystem**: Prevents runtime modifications
- **Capability dropping**: Remove all unnecessary Linux capabilities
- **Security contexts**: Enforce security policies at pod and container level

#### 2. Image Security

```dockerfile
# Security-hardened Dockerfile example
FROM node:20-alpine AS base

# Create non-root user
RUN addgroup -g 1000 -S nodejs && \
    adduser -S aihub -u 1000 -G nodejs

# Install security updates
RUN apk update && apk upgrade && \
    apk add --no-cache dumb-init curl && \
    rm -rf /var/cache/apk/*

# Use specific digest for reproducible builds
FROM base@sha256:specific-digest AS production

# Copy with proper ownership
COPY --from=builder --chown=aihub:nodejs /app/dist ./
```

#### 3. Secrets Management

```yaml
# External Secrets Operator configuration
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-secret-store
  namespace: ai-hub-apps
spec:
  provider:
    vault:
      server: 'https://vault.company.com'
      path: 'secret'
      auth:
        kubernetes:
          mountPath: 'kubernetes'
          role: 'ai-hub-apps-role'

---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ai-hub-apps-secrets
  namespace: ai-hub-apps
spec:
  refreshInterval: 15s
  secretStoreRef:
    name: vault-secret-store
    kind: SecretStore
  target:
    name: ai-hub-apps-secrets
    creationPolicy: Owner
  data:
    - secretKey: OPENAI_API_KEY
      remoteRef:
        key: ai-hub-apps/prod
        property: openai_api_key
    - secretKey: JWT_SECRET
      remoteRef:
        key: ai-hub-apps/prod
        property: jwt_secret
```

#### 4. Network Security

```yaml
# Strict network policy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ai-hub-apps-strict-policy
  namespace: ai-hub-apps
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ai-hub-apps
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Only allow ingress from nginx ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - protocol: TCP
          port: 3000
    # Allow monitoring scraping
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - protocol: TCP
          port: 3000
  egress:
    # DNS resolution
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: UDP
          port: 53
    # HTTPS to LLM APIs only
    - to: []
      ports:
        - protocol: TCP
          port: 443
  # No other egress allowed
```

### Pod Security Standards

```yaml
# Pod Security Policy (for older Kubernetes versions)
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: ai-hub-apps-psp
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'projected'
    - 'secret'
    - 'downwardAPI'
    - 'persistentVolumeClaim'
  runAsUser:
    rule: 'MustRunAsNonRoot'
  runAsGroup:
    rule: 'MustRunAs'
    ranges:
      - min: 1001
        max: 1001
  fsGroup:
    rule: 'MustRunAs'
    ranges:
      - min: 1001
        max: 1001
  readOnlyRootFilesystem: true
  seLinux:
    rule: 'RunAsAny'

---
# For Kubernetes 1.25+ use Pod Security Standards
apiVersion: v1
kind: Namespace
metadata:
  name: ai-hub-apps
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### Security Scanning Pipeline

```yaml
# .github/workflows/security-scan.yml
name: Security Scan
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Build Docker image
        run: docker build -t ai-hub-apps:test .

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'ai-hub-apps:test'
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Scan for secrets
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: main
          head: HEAD
```

## Operational Security

### 1. Runtime Security Monitoring

```yaml
# Falco rules for iHub Apps
- rule: Unexpected Network Connection
  desc: Detect unexpected network connections from iHub Apps
  condition: >
    (spawned_process and container.name contains "ai-hub-apps") and
    (outbound and not fd.sport in (80, 443, 53))
  output: >
    Unexpected network connection from iHub Apps
    (command=%proc.cmdline connection=%fd.name container=%container.name)
  priority: WARNING

- rule: File System Write in Read-Only Container
  desc: Detect attempts to write to read-only filesystem
  condition: >
    (open_write and container.name contains "ai-hub-apps") and
    not fd.name startswith "/app/contents/data" and
    not fd.name startswith "/app/contents/uploads" and
    not fd.name startswith "/app/logs"
  output: >
    Write attempt to read-only filesystem
    (file=%fd.name container=%container.name)
  priority: ERROR
```

### 2. Security Benchmarks

```bash
#!/bin/bash
# security-benchmark.sh - CIS Kubernetes Benchmark checks

echo "Running security benchmark checks..."

# Check for non-root containers
kubectl get pods -n ai-hub-apps -o jsonpath='{.items[*].spec.securityContext.runAsUser}' | grep -v 1001 && echo "FAIL: Container running as root" || echo "PASS: Non-root containers"

# Check for read-only root filesystem
kubectl get pods -n ai-hub-apps -o jsonpath='{.items[*].spec.containers[*].securityContext.readOnlyRootFilesystem}' | grep -v true && echo "FAIL: Root filesystem not read-only" || echo "PASS: Read-only root filesystem"

# Check for dropped capabilities
kubectl get pods -n ai-hub-apps -o jsonpath='{.items[*].spec.containers[*].securityContext.capabilities.drop}' | grep -v ALL && echo "FAIL: Capabilities not dropped" || echo "PASS: All capabilities dropped"

# Check resource limits
kubectl get pods -n ai-hub-apps -o jsonpath='{.items[*].spec.containers[*].resources.limits}' | grep -q memory && echo "PASS: Resource limits set" || echo "FAIL: No resource limits"
```

## Backup and Disaster Recovery

### 1. Backup Strategy

```yaml
# Velero backup configuration
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: ai-hub-apps-daily
  namespace: velero
spec:
  includedNamespaces:
    - ai-hub-apps
  includedResources:
    - persistentvolumes
    - persistentvolumeclaims
    - secrets
    - configmaps
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: ai-hub-apps
  storageLocation: default
  ttl: 720h0m0s # 30 days

---
# Scheduled backup
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: ai-hub-apps-backup-schedule
  namespace: velero
spec:
  schedule: '0 2 * * *' # Daily at 2 AM
  template:
    includedNamespaces:
      - ai-hub-apps
    storageLocation: default
    ttl: 720h0m0s
```

### 2. Data Backup Scripts

```bash
#!/bin/bash
# backup-data.sh - Backup critical data volumes

BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/ai-hub-apps/$BACKUP_DATE"

echo "Starting backup to $BACKUP_DIR"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup data volume
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- tar czf - /app/contents/data | cat > "$BACKUP_DIR/data.tar.gz"

# Backup uploads
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- tar czf - /app/contents/uploads | cat > "$BACKUP_DIR/uploads.tar.gz"

# Backup configurations
kubectl get configmaps -n ai-hub-apps -o yaml > "$BACKUP_DIR/configmaps.yaml"
kubectl get secrets -n ai-hub-apps -o yaml > "$BACKUP_DIR/secrets.yaml"

# Create backup metadata
cat > "$BACKUP_DIR/metadata.json" <<EOF
{
  "backup_date": "$BACKUP_DATE",
  "kubernetes_version": "$(kubectl version --short --client)",
  "ai_hub_version": "$(kubectl get deployment ai-hub-apps -n ai-hub-apps -o jsonpath='{.spec.template.spec.containers[0].image}')",
  "replica_count": "$(kubectl get deployment ai-hub-apps -n ai-hub-apps -o jsonpath='{.spec.replicas}')"
}
EOF

echo "Backup completed: $BACKUP_DIR"
```

### 3. Disaster Recovery Procedures

```bash
#!/bin/bash
# disaster-recovery.sh - Disaster recovery procedures

BACKUP_DATE=$1
BACKUP_DIR="/backups/ai-hub-apps/$BACKUP_DATE"

if [ -z "$BACKUP_DATE" ]; then
    echo "Usage: $0 <backup_date>"
    echo "Available backups:"
    ls -la /backups/ai-hub-apps/
    exit 1
fi

echo "Starting disaster recovery from backup: $BACKUP_DATE"

# 1. Recreate namespace and resources
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-pvc.yaml

# 2. Restore configurations
kubectl apply -f "$BACKUP_DIR/configmaps.yaml"
kubectl apply -f "$BACKUP_DIR/secrets.yaml"

# 3. Deploy application
kubectl apply -f k8s/03-deployment.yaml
kubectl apply -f k8s/04-service.yaml

# 4. Wait for pods to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=ai-hub-apps -n ai-hub-apps --timeout=300s

# 5. Restore data
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- rm -rf /app/contents/data/*
kubectl exec -i -n ai-hub-apps deployment/ai-hub-apps -- tar xzf - -C / < "$BACKUP_DIR/data.tar.gz"

kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- rm -rf /app/contents/uploads/*
kubectl exec -i -n ai-hub-apps deployment/ai-hub-apps -- tar xzf - -C / < "$BACKUP_DIR/uploads.tar.gz"

# 6. Verify recovery
echo "Verifying recovery..."
kubectl get pods -n ai-hub-apps
kubectl logs -n ai-hub-apps deployment/ai-hub-apps --tail=50

echo "Disaster recovery completed"
```

## Monitoring and Alerting

### 1. Prometheus Monitoring

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ai-hub-apps-rules
  namespace: ai-hub-apps
spec:
  groups:
    - name: ai-hub-apps.rules
      rules:
        - alert: AIHubAppsDown
          expr: up{job="ai-hub-apps"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: 'iHub Apps is down'
            description: 'iHub Apps has been down for more than 5 minutes'

        - alert: AIHubAppsHighMemoryUsage
          expr: (container_memory_usage_bytes{container="ai-hub-apps"} / container_spec_memory_limit_bytes{container="ai-hub-apps"}) > 0.9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: 'iHub Apps high memory usage'
            description: 'Memory usage is above 90% for more than 10 minutes'

        - alert: AIHubAppsHighCPUUsage
          expr: rate(container_cpu_usage_seconds_total{container="ai-hub-apps"}[5m]) > 0.8
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: 'iHub Apps high CPU usage'
            description: 'CPU usage is above 80% for more than 15 minutes'

        - alert: AIHubAppsHighErrorRate
          expr: rate(http_requests_total{job="ai-hub-apps",status=~"5.."}[5m]) / rate(http_requests_total{job="ai-hub-apps"}[5m]) > 0.1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: 'iHub Apps high error rate'
            description: 'Error rate is above 10% for more than 5 minutes'
```

### 2. Log Aggregation

```yaml
# fluentd-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
  namespace: ai-hub-apps
data:
  fluent.conf: |
    <source>
      @type tail
      path /app/logs/*.log
      pos_file /var/log/fluentd-ai-hub-apps.log.pos
      tag ai-hub-apps.*
      format json
      time_key timestamp
      time_format %Y-%m-%dT%H:%M:%S.%LZ
    </source>

    <filter ai-hub-apps.**>
      @type parser
      key_name message
      reserve_data true
      <parse>
        @type json
      </parse>
    </filter>

    <match ai-hub-apps.**>
      @type elasticsearch
      host elasticsearch.logging.svc.cluster.local
      port 9200
      logstash_format true
      logstash_prefix ai-hub-apps
      include_tag_key true
      tag_key @log_name
    </match>
```

## Performance Optimization

### 1. Resource Management

```yaml
# Vertical Pod Autoscaler
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ai-hub-apps-vpa
  namespace: ai-hub-apps
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ai-hub-apps
  updatePolicy:
    updateMode: 'Auto'
  resourcePolicy:
    containerPolicies:
      - containerName: ai-hub-apps
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 4
          memory: 8Gi
```

### 2. Caching Strategy

```yaml
# Redis cache deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-cache
  namespace: ai-hub-apps
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis-cache
  template:
    metadata:
      labels:
        app: redis-cache
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: '256Mi'
              cpu: '250m'
            limits:
              memory: '512Mi'
              cpu: '500m'
          volumeMounts:
            - name: redis-data
              mountPath: /data
      volumes:
        - name: redis-data
          persistentVolumeClaim:
            claimName: redis-cache-pvc
```

## Compliance and Auditing

### 1. Audit Logging

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - RequestReceived
rules:
  - level: Metadata
    namespaces: ['ai-hub-apps']
    resources:
      - group: ''
        resources: ['secrets', 'configmaps']
      - group: 'apps'
        resources: ['deployments']
  - level: RequestResponse
    namespaces: ['ai-hub-apps']
    resources:
      - group: ''
        resources: ['persistentvolumeclaims']
    verbs: ['create', 'update', 'patch', 'delete']
```

### 2. Compliance Scanning

```bash
#!/bin/bash
# compliance-scan.sh - Run compliance checks

echo "Running compliance scans..."

# GDPR compliance check
echo "Checking GDPR compliance..."
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- find /app/contents/data -name "*.jsonl" -exec grep -l "personal_data" {} \; | wc -l

# SOC2 compliance check
echo "Checking access controls..."
kubectl auth can-i create secrets --as=system:serviceaccount:ai-hub-apps:ai-hub-apps -n ai-hub-apps

# Data retention check
echo "Checking data retention policies..."
find /backups/ai-hub-apps -type d -mtime +30 -exec rm -rf {} \;

echo "Compliance scan completed"
```

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Pod Startup Issues

```bash
# Check pod status
kubectl describe pod <pod-name> -n ai-hub-apps

# Check resource constraints
kubectl top pod <pod-name> -n ai-hub-apps

# Inspect logs
kubectl logs <pod-name> -n ai-hub-apps --previous
```

#### 2. Storage Issues

```bash
# Check PVC status
kubectl get pvc -n ai-hub-apps

# Check storage usage
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- df -h
```

#### 3. Network Issues

```bash
# Test connectivity
kubectl exec -n ai-hub-apps deployment/ai-hub-apps -- nslookup google.com

# Check network policies
kubectl describe networkpolicy -n ai-hub-apps
```

This comprehensive security and operations guide provides the foundation for running iHub Apps in a secure, compliant, and operationally sound containerized environment.
