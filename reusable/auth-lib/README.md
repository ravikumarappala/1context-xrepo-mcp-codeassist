# auth-lib (reusable)

Shared sign-in token helpers: `signToken`, `verifyToken`, `userFromRequest`.
Used by `orders-api`. Published as `@acme/auth-lib`; in this sample other folders import it by relative path.

Demo-only HMAC tokens so everything runs offline. Real systems use their identity provider.
