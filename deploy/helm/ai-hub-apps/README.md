# AI Hub Apps Helm Chart

This chart deploys the AI Hub Apps using an init container to pull configuration files from an S3 bucket. The init container relies on IAM permissions associated with the service account, so no static AWS credentials are required.

## Installing the Chart

```bash
helm upgrade --install ai-hub-apps ./deploy/helm/ai-hub-apps \
  --set image.repository=ghcr.io/your-org/ai-hub-apps \
  --set s3Bucket=s3://my-aihub-config
```

Adjust the image repository and S3 bucket as needed. The application reads configuration from `/app/contents` and assets from `/app/public` in the shared volume populated by the init container.
