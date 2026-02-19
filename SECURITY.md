# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AlphaPolyBot, please report it responsibly.

**Do not open a public issue.** Instead, email the maintainer directly or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

### What qualifies as a security issue?

- Vulnerabilities in order signing or transaction construction
- Wallet seed phrase or private key exposure risks
- API key leakage (OpenRouter, Coinbase, Polymarket)
- Cross-site scripting (XSS) in the dashboard UI
- Insecure storage of sensitive data
- Any issue that could lead to unauthorized fund movement

### What does NOT qualify?

- Trading strategy performance issues
- UI display bugs
- Feature requests

## Secure Development Practices

- **Wallet credentials** are stored in encrypted localStorage via `secureStorage` with AES-GCM
- **API keys** are stored in Zustand persist (browser localStorage) — use `.env` for server-side keys
- **CSP headers** are configured in production (`netlify.toml`) and testable via `npm run dev:strict-csp`
- **No eval()** — Vite build uses esbuild transform, no runtime code generation
- **Dedicated wallet** — documentation instructs users to never use their primary wallet

## Supported Versions

| Version | Supported |
|:--------|:----------|
| Latest `main` | Yes |
| Older commits | No |
