# Kubernetes Deployment Guide for iHub Apps

**Document Version:** 1.0  
**Date:** 2025-07-28  
**Author:** Claude Code  
**Purpose:** Provide comprehensive Kubernetes deployment configurations and operational procedures

## Overview

This guide provides production-ready Kubernetes manifests and Helm charts for deploying iHub Apps at scale. The deployment supports:

- **High Availability**: Multiple replicas with rolling updates
- **Auto-scaling**: Horizontal Pod Autoscaler based on CPU/memory metrics
- **Persistent Storage**: Proper volume management for data persistence
- **Security**: RBAC, Pod Security Standards, and network policies
- **Monitoring**: Prometheus metrics and health checks
- **Ingress**: SSL termination and load balancing

## Kubernetes Manifest Files

### 1. Namespace and RBAC

```yaml
# k8s/00-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ihub-apps
  labels:
    name: ihub-apps
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production

---
# Service Account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ihub-apps
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production

---
# Role for accessing ConfigMaps and Secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: ihub-apps
  name: ihub-apps-role
rules:
  - apiGroups: ['']
    resources: ['configmaps', 'secrets']
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['get', 'list']

---
# RoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ihub-apps-rolebinding
  namespace: ihub-apps
subjects:
  - kind: ServiceAccount
    name: ihub-apps
    namespace: ihub-apps
roleRef:
  kind: Role
  name: ihub-apps-role
  apiGroup: rbac.authorization.k8s.io
```

### 2. ConfigMaps and Secrets

```yaml
# k8s/01-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ihub-apps-config
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
data:
  NODE_ENV: 'production'
  LOG_LEVEL: 'info'
  WORKERS: '4'
  PORT: '3000'
  HOST: '0.0.0.0'
  MAX_UPLOAD_SIZE: '50mb'
  UPLOAD_PATH: '/app/contents/uploads'
  ENABLE_TELEMETRY: 'true'
  REQUEST_TIMEOUT: '30000'
  CORS_ORIGIN: 'https://yourdomain.com'

---
# Configuration files ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: ihub-apps-files
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
data:
  # These would be populated from your actual config files
  platform.json: |
    {
      "features": {
        "usageTracking": true
      },
      "defaultLanguage": "en",
      "requestBodyLimitMB": 50
    }
  # Add other config files as needed

---
# Secrets for sensitive data
apiVersion: v1
kind: Secret
metadata:
  name: ihub-apps-secrets
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
type: Opaque
data:
  # Base64 encoded values - use kubectl create secret or external secret management
  JWT_SECRET: eW91cl9qd3Rfc2VjcmV0X2hlcmU=
  ADMIN_SECRET: eW91cl9hZG1pbl9zZWNyZXRfaGVyZQ==
  OPENAI_API_KEY: eW91cl9vcGVuYWlfa2V5X2hlcmU=
  ANTHROPIC_API_KEY: eW91cl9hbnRocm9waWNfa2V5X2hlcmU=
  GOOGLE_API_KEY: eW91cl9nb29nbGVfa2V5X2hlcmU=
  MISTRAL_API_KEY: eW91cl9taXN0cmFsX2tleV9oZXJl
```

### 3. Persistent Volume Claims

```yaml
# k8s/02-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ihub-apps-config-pvc
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  accessModes:
    - ReadOnlyMany
  resources:
    requests:
      storage: 1Gi
  storageClassName: fast-ssd

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ihub-apps-data-pvc
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 10Gi
  storageClassName: fast-ssd

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ihub-apps-uploads-pvc
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 50Gi
  storageClassName: standard

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ihub-apps-logs-pvc
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 5Gi
  storageClassName: standard
```

### 4. Deployment

```yaml
# k8s/03-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
    app.kubernetes.io/version: '1.0.5'
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ihub-apps
      app.kubernetes.io/instance: production
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ihub-apps
        app.kubernetes.io/instance: production
        app.kubernetes.io/version: '1.0.5'
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '3000'
        prometheus.io/path: '/api/metrics'
    spec:
      serviceAccountName: ihub-apps
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001
      containers:
        - name: ihub-apps
          image: ihub-apps:1.0.5
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          env:
            - name: NODE_ENV
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: NODE_ENV
            - name: LOG_LEVEL
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: LOG_LEVEL
            - name: WORKERS
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: WORKERS
            - name: PORT
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: PORT
            - name: HOST
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: HOST
            - name: CORS_ORIGIN
              valueFrom:
                configMapKeyRef:
                  name: ihub-apps-config
                  key: CORS_ORIGIN
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: JWT_SECRET
            - name: ADMIN_SECRET
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: ADMIN_SECRET
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: OPENAI_API_KEY
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: ANTHROPIC_API_KEY
            - name: GOOGLE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: GOOGLE_API_KEY
            - name: MISTRAL_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ihub-apps-secrets
                  key: MISTRAL_API_KEY
          volumeMounts:
            - name: config-volume
              mountPath: /app/contents/config
              readOnly: true
            - name: data-volume
              mountPath: /app/contents/data
            - name: uploads-volume
              mountPath: /app/contents/uploads
            - name: logs-volume
              mountPath: /app/logs
            - name: config-files
              mountPath: /app/contents/config/platform.json
              subPath: platform.json
              readOnly: true
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'
            limits:
              memory: '2Gi'
              cpu: '2000m'
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: config-volume
          persistentVolumeClaim:
            claimName: ihub-apps-config-pvc
        - name: data-volume
          persistentVolumeClaim:
            claimName: ihub-apps-data-pvc
        - name: uploads-volume
          persistentVolumeClaim:
            claimName: ihub-apps-uploads-pvc
        - name: logs-volume
          persistentVolumeClaim:
            claimName: ihub-apps-logs-pvc
        - name: config-files
          configMap:
            name: ihub-apps-files
      restartPolicy: Always
      terminationGracePeriodSeconds: 30
```

### 5. Service and Ingress

```yaml
# k8s/04-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: ihub-apps-service
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  type: ClusterIP
  ports:
    - port: 3000
      targetPort: http
      protocol: TCP
      name: http
  selector:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production

---
# Ingress for external access
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ihub-apps-ingress
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: '50m'
    nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '300'
    nginx.ingress.kubernetes.io/rate-limit: '100'
    nginx.ingress.kubernetes.io/rate-limit-window: '1m'
spec:
  tls:
    - hosts:
        - yourdomain.com
      secretName: ihub-apps-tls
  rules:
    - host: yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ihub-apps-service
                port:
                  number: 3000
```

### 6. Horizontal Pod Autoscaler

```yaml
# k8s/05-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ihub-apps-hpa
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ihub-apps
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
```

### 7. Network Policy

```yaml
# k8s/06-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ihub-apps-network-policy
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
    app.kubernetes.io/instance: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ihub-apps
      app.kubernetes.io/instance: production
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to: [] # Allow all outbound traffic for LLM API calls
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 80
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: TCP
          port: 53
        - protocol: UDP
          port: 53
```

## Helm Chart

### Chart.yaml

```yaml
# helm-chart/Chart.yaml
apiVersion: v2
name: ihub-apps
description: A Helm chart for iHub Apps
type: application
version: 1.0.5
appVersion: '1.0.5'
home: https://github.com/yourusername/ihub-apps
sources:
  - https://github.com/yourusername/ihub-apps
maintainers:
  - name: Your Name
    email: your.email@company.com
keywords:
  - ai
  - llm
  - chatbot
  - applications
```

### values.yaml

```yaml
# helm-chart/values.yaml
replicaCount: 3

image:
  repository: ihub-apps
  pullPolicy: Always
  tag: '1.0.5'

nameOverride: ''
fullnameOverride: ''

serviceAccount:
  create: true
  annotations: {}
  name: ''

podAnnotations:
  prometheus.io/scrape: 'true'
  prometheus.io/port: '3000'
  prometheus.io/path: '/api/metrics'

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1001
  runAsGroup: 1001
  fsGroup: 1001

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

service:
  type: ClusterIP
  port: 3000

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: '50m'
    nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
    nginx.ingress.kubernetes.io/rate-limit: '100'
  hosts:
    - host: yourdomain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: ihub-apps-tls
      hosts:
        - yourdomain.com

resources:
  requests:
    memory: '512Mi'
    cpu: '500m'
  limits:
    memory: '2Gi'
    cpu: '2000m'

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80

persistence:
  config:
    enabled: true
    size: 1Gi
    storageClass: fast-ssd
    accessMode: ReadOnlyMany
  data:
    enabled: true
    size: 10Gi
    storageClass: fast-ssd
    accessMode: ReadWriteMany
  uploads:
    enabled: true
    size: 50Gi
    storageClass: standard
    accessMode: ReadWriteMany
  logs:
    enabled: true
    size: 5Gi
    storageClass: standard
    accessMode: ReadWriteMany

config:
  nodeEnv: production
  logLevel: info
  workers: 4
  corsOrigin: 'https://yourdomain.com'
  maxUploadSize: '50mb'
  enableTelemetry: true

secrets:
  jwtSecret: ''
  adminSecret: ''
  openaiApiKey: ''
  anthropicApiKey: ''
  googleApiKey: ''
  mistralApiKey: ''

networkPolicy:
  enabled: true
```

## Deployment Commands

### Using kubectl

```bash
# Create namespace and apply all manifests
kubectl apply -f k8s/

# Check deployment status
kubectl get pods -n ihub-apps
kubectl get services -n ihub-apps
kubectl get ingress -n ihub-apps

# View logs
kubectl logs -f deployment/ihub-apps -n ihub-apps

# Scale deployment
kubectl scale deployment ihub-apps --replicas=5 -n ihub-apps

# Rolling update
kubectl set image deployment/ihub-apps ihub-apps=ihub-apps:v1.0.6 -n ihub-apps

# Rollback
kubectl rollout undo deployment/ihub-apps -n ihub-apps
```

### Using Helm

```bash
# Install chart
helm install ihub-apps ./helm-chart -n ihub-apps --create-namespace

# Upgrade
helm upgrade ihub-apps ./helm-chart -n ihub-apps

# Rollback
helm rollback ihub-apps 1 -n ihub-apps

# Uninstall
helm uninstall ihub-apps -n ihub-apps
```

## Monitoring and Observability

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ihub-apps-metrics
  namespace: ihub-apps
  labels:
    app.kubernetes.io/name: ihub-apps
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ihub-apps
  endpoints:
    - port: http
      path: /api/metrics
      interval: 30s
```

### Grafana Dashboard Configuration

```json
{
  "dashboard": {
    "title": "iHub Apps",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total{service=\"ihub-apps\"}[5m])"
          }
        ]
      },
      {
        "title": "Response Time",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service=\"ihub-apps\"}[5m]))"
          }
        ]
      },
      {
        "title": "Active Connections",
        "targets": [
          {
            "expr": "nodejs_active_handles{service=\"ihub-apps\"}"
          }
        ]
      }
    ]
  }
}
```

## Operational Procedures

### Health Checks and Troubleshooting

```bash
# Check pod health
kubectl describe pod <pod-name> -n ihub-apps

# Access pod shell for debugging
kubectl exec -it <pod-name> -n ihub-apps -- sh

# Check resource usage
kubectl top pods -n ihub-apps

# View events
kubectl get events -n ihub-apps --sort-by=.metadata.creationTimestamp
```

### Backup and Recovery

```bash
# Backup persistent volumes
kubectl create job --from=cronjob/backup-job backup-manual-$(date +%Y%m%d%H%M%S) -n ihub-apps

# Restore from backup
kubectl apply -f backup-restore-job.yaml
```

This Kubernetes deployment guide provides a comprehensive foundation for running iHub Apps at enterprise scale with proper security, monitoring, and operational procedures.
