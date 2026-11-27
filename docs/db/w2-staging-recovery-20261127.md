# W2 staging recovery: storage, approval, email and client IP

Use the staging database and synthetic test data. Never copy staging bypasses into production.

## 1. Spaces browser PUT and completion
In the existing renivet-staging-media Space, Settings > CORS, add the exact staging frontend origin https://renivet-staging-frontend-ta82b.ondigitalocean.app. Allow PUT, GET and HEAD; permit Content-Type, Cache-Control, x-amz-acl, x-amz-meta-renivet-brand-id, x-amz-meta-renivet-media-asset-id, x-amz-meta-renivet-import-upload-id, x-amz-meta-renivet-sha256. Preserve existing legitimate rules. Keep objects private. Confirm OPTIONS preflight, signed PUT, completion and product attachment; then import a small synthetic CSV. The server continues to validate metadata, size and SHA-256. Do not disable these checks.

## 2. Brand approval
Check using the actual backend database role:
```sql
SELECT current_database(), current_user,
       to_regclass('brands.brand_application_checker_attestations') AS checker_table;
```
If missing, back up the database and apply the reviewed migration journal with the repository migration command using the secure staging DATABASE_URL. On the new backend image, run exactly one explicit migration job from /app:
```sh
node dist/db/run-migrations.js --apply --database=renivet_staging
```
The job verifies database name and takes an advisory lock. Do not apply individual SQL files out of sequence or mark missing migrations as complete. If the table exists, check SELECT and INSERT privileges for the runtime DB role. Preserve distinct maker/checker accounts. Do not bypass the checker.

## 3. Email
Set EMAIL_OTP_PROVIDER=resend_direct in backend runtime settings, set RESEND_API_KEY securely and RESEND_FROM to a verified sender, or use the existing supported SMTP Resend API-key fallback. Test password recovery and team invitation independently. Rotate exposed credentials and never paste secrets in logs.

## 4. Login source IP
The Next.js BFF and public NestJS backend are separate apps. DigitalOcean documents do-connecting-ip as client IP; x-forwarded-for contains ingress IP. Before activation, verify ingress overwrites caller-supplied do-connecting-ip on both apps and direct access cannot bypass the trusted ingress. Do not enable generic trustProxy=true. Generate a fresh dedicated random 32-byte secret and configure AUTH_PROXY_CLIENT_IP_HMAC_KEY to the same value in both services (runtime only, encrypted, never NEXT_PUBLIC). Set AUTH_TRUST_DO_CONNECTING_IP=true on both apps only after ingress verification. The BFF signs source IP and auth operation with a 30-second proof; backend validates signature and expiry. Otherwise it retains socket-IP fallback. Deploy both together; exercise failures from IP A and valid login from IP B, spoofed forwarding headers, direct API and rate limits. This feature is opt-in.

## Release gate
Run CI, the disposable migration replay, signed upload tests and two-IP authentication tests before promoting. Confirm both deployed commits and complete staging E2E. No application role elevation, CSRF bypass, or public bucket required.
