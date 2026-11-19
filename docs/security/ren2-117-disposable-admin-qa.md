# REN2-117 — Disposable admin review cases

This is a local QA dataset, **not production seed data**. It creates synthetic users, a pending brand application, an approved demo brand, and pending records for Taxonomy, Product QC, Pricing and Claims, plus one independently approved product for Publishing. It does not touch real customers, payment information, email delivery, bank details, or inventory commitments.

## Prerequisites

Use the disposable PostgreSQL 16 service with the dedicated `renivet_ci` role and the **`renivet_ci` database**, bound to **127.0.0.1:5432**. Run the existing migrations, including the W1 access and W2 catalogue migrations, before seeding. Do not reuse an application database or a shared/staging/prod database. Install dependencies and build the backend first.

```bash
npm ci
npm run build
RENIVET_ALLOW_DISPOSABLE_SEED=1 \
RENIVET_TEST_DATABASE_URL="postgresql://renivet_ci:<local-test-password>@127.0.0.1:5432/renivet_ci" \
node scripts/seed-ren2-117-disposable-reviews.cjs
```

Use your actual disposable test password. Never commit it. On Windows PowerShell use:

```powershell
$env:RENIVET_ALLOW_DISPOSABLE_SEED = "1"
$env:RENIVET_TEST_DATABASE_URL = "postgresql://renivet_ci:<local-test-password>@127.0.0.1:5432/renivet_ci"
node scripts/seed-ren2-117-disposable-reviews.cjs
```

Clear these environment variables after the disposable QA session.

The script refuses execution without its explicit opt-in or if the database host/user/name/port does not exactly match the disposable test configuration. It is intended to run once in a fresh disposable DB and stops on later invocations if its approved demo brand exists. **This has not been executed on the user's localhost database.**

## Verification

Start the backend and frontend against this same disposable DB. Sign in with an **existing, independently authorized global Renivet admin**. Synthetic user records created by the script have no usable passwords and cannot sign in. They are safe submitters/reviewers for test case associations; they must not be converted into production accounts.

Check the brand application list and the five catalogue queues. A reviewer cannot approve a taxonomy/product proposal they submitted, and permissions, CSRF, server-managed MFA, and immutable audit logs still apply.

If a seed run fails after the database transaction was committed, reset and remigrate the **entire disposable test database** before trying again; never silently edit immutable events or create duplicates. The seed provides a labeled demo global admin role assignment visible in the **read-only Staff & Access** directory and a synthetic independently eligible reviewer for local testing. It does not provide bank verification, inventory exception, or privacy-request cases, because those need distinct approved backend contracts and policy-safe fixtures. No seeded record should be treated as a real merchant, verified claim or live stock.

The current taxonomy flow is:
1. Create an inactive category (globally authorized only).
2. Select and submit product details.
3. A separate authorized admin approves the exact version.
4. An authorized admin activates the published category when appropriate, per existing backend policy.

## REN2-118 application and MFA experience

Use the seller route `/brands/join/application` to submit a **new initial pending application**. Its saved business and brand names appear in `/brand-approvals` for an authorized administrator; the seller can see pending status on the same application page. The admin approval picker is populated from the authorized global reviewer directory, rather than requiring a manually copied UUID. W2 documents and bank evidence are not collected or inferred by this initial application.

Creation, taxonomy updates, imports and media uploads use an authenticated session, scoped permissions, session-bound CSRF, and backend audit without a new authenticator step-up. **Independent approval remains separately protected** where the server policy requires it. The current W1 Staff & Access screen is **read-only**: it lists persisted platform role assignments and cannot grant or revoke access.

The new W1 application and admin/staff endpoints have not yet been included in a reviewed generated OpenAPI contract and should not be released before that contract and authenticated browser acceptance are completed.
