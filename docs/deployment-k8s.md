# Kubernetes Deployment Guide

This guide describes how to deploy AI Hub Apps on Kubernetes using Helm and Argo CD. Configuration files are stored in an S3 bucket and fetched by an init container at startup.

## 1. Build and Publish the Docker Image

A GitHub Actions workflow (`.github/workflows/docker-image.yml`) builds and publishes the Docker image to GitHub Container Registry. Push the `main` branch or run the workflow manually to create `ghcr.io/<your-org>/ai-hub-apps:SHA` images.

## 2. Prepare S3 Bucket

Store your `contents/` and `public/` directories in an S3 bucket (e.g., `s3://my-aihub-config`).
Create an IAM role with read access to the bucket and associate it with a
Kubernetes service account (IRSA) or provide AWS credentials through a
Secret so the init container can authenticate to S3.

## 3. Install the Helm Chart

Run the following command after cloning the repository:

```bash
helm upgrade --install ai-hub-apps ./deploy/helm/ai-hub-apps \
  --set image.repository=ghcr.io/<your-org>/ai-hub-apps \
  --set image.tag=<tag> \
  --set s3Bucket=s3://my-aihub-config
```

The chart creates a deployment with an init container that syncs files from S3
into a shared volume. The main container mounts `/app/contents` and
`/app/public` from this volume using `subPath` so the bundled application code
remains available.

## 4. Deploy with Argo CD

Apply the Argo CD application manifest:

```bash
kubectl apply -f deploy/argocd/application.yaml
```

Argo CD will pull the chart from the repository and deploy it using the values in `deploy/argocd/values.yaml`. Update the repository URL or branch as needed.

## 5. Updating Configuration

Update files in the S3 bucket to change logos, CSS or app configuration. Restart the pod to fetch the latest files. Because the bucket is read during initialization, no container rebuild is required.
