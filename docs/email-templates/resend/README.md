# Renivet transactional email templates for Resend

Original Renivet-branded templates for email verification and password recovery. The verification email welcomes new customers while asking them to verify their address. The templates use a warm ivory background, deep green brand color, a clear OTP card, and a compact mobile-friendly layout.

## Published templates

| File | Published alias | Subject | Variables |
|---|---|---|---|
| `email-verification.html` | `email-verification` | Welcome to Renivet — verify your email | `OTP_CODE` (string); `EXPIRY_MINUTES` (number) |
| `password-recovery.html` | `reset_password` | Your Renivet password reset code | `OTP_CODE` (string); `EXPIRY_MINUTES` (number) |

The HTML uses Resend's `{{{VARIABLE}}}` template syntax. Keep the OTP as text so leading zeroes are preserved. Any fallback code is only for editor preview and must never appear in a live email.

## Backend configuration

Set `EMAIL_OTP_PROVIDER=resend` to send email verification and password recovery through Resend's Email API. The aliases above are the defaults; override them with `RESEND_EMAIL_VERIFICATION_TEMPLATE_ID` and `RESEND_PASSWORD_RECOVERY_TEMPLATE_ID` if they change. Set `RESEND_API_KEY` and `RESEND_FROM` on the backend. `RESEND_FROM` may use `SMTP_FROM` when both providers share a verified sender. For an existing Resend SMTP setup only, `SMTP_PASSWORD` is accepted as the API key when `SMTP_HOST=smtp.resend.com`.

Set `EMAIL_OTP_PROVIDER=smtp` (the default) to switch back to SMTP-rendered email. Exactly one email provider is selected; failures are not silently retried through the other provider, avoiding duplicate OTP emails. Phone OTP remains on Fast2SMS.

The backend passes `OTP_CODE` and `EXPIRY_MINUTES` to the hosted template. It does not send a separate post-verification welcome email; the verification template is the welcome touchpoint. Order, shipping, payment, and marketing emails are outside the current identity flow.

Keep API keys and SMTP credentials in the backend's local environment or secret store only. Never place them in frontend configuration or commit them.
