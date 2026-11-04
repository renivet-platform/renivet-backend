# REN2-66 media service configuration

The media API is enabled only when private object storage and a malware scanner are configured. Upload completion fails closed if the scanner or storage service is unavailable.

## Required runtime configuration

Provide these values through the deployment secret/configuration manager:

| Setting | Purpose |
| --- | --- |
| `MEDIA_SPACES_ENDPOINT` | HTTPS DigitalOcean Spaces regional endpoint, such as `https://nyc3.digitaloceanspaces.com`. Arbitrary hosts and HTTP are rejected. |
| `MEDIA_SPACES_REGION` | S3 signing region for that Spaces endpoint. |
| `MEDIA_SPACES_BUCKET` | Private bucket used for original uploads and generated derivatives. |
| `MEDIA_SPACES_ACCESS_KEY_ID` | Scoped Spaces access key. |
| `MEDIA_SPACES_SECRET_ACCESS_KEY` | Matching secret key. |
| `MEDIA_CLAMD_HOST` | Private network host for the ClamAV `clamd` service. |
| `MEDIA_CLAMD_PORT` | ClamAV TCP port, normally `3310`. |

Keep the bucket private and restrict the key to the required bucket. Do not expose credentials in browser configuration, URLs, logs, or committed files. Upload capabilities expire after five minutes; clean preview URLs expire after one minute. The service accepts JPEG, PNG, and WebP up to 10 MiB and creates metadata-stripped WebP preview and thumbnail derivatives.

This PR implements the application boundary and tests. It does not provide production credentials, deploy a scanner/storage service, or satisfy runtime activation evidence. G04 and G07 remain release gates; runtime ownership and observability evidence must be collected before any production activation decision.
