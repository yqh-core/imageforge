# ImageForge — Developer handoff

**Site:** https://draw.digdevbox.com  
**Repository:** https://github.com/yqh-core/imageforge  
**Portfolio status:** HOLD — no roadmap expansion; critical security, availability and compatibility maintenance only unless explicitly reprioritized.

## Product

ImageForge is a browser-based image editor based on miniPaint. The existing product supports opening and editing images, layers, retouching, filters and export. Preserve browser-side processing and do not introduce image uploads or third-party processing without a reviewed privacy decision.

## Environment and commands

`package.json` requires Node.js >=22. `package-lock.json` is committed; use npm and the lockfile.

```bash
npm ci
npm run dev
npm run serve
```

For a release artifact:

```bash
npm run ship:cloudflare
npm run preview
```

Relevant verification scripts:

```bash
npm run verify
npm run probe
npm run check:ga4-consent
```

`verify` uses real Chrome to inspect the built artifact and runs the analytics-consent check. `probe` exercises key editing functions. Read the current package scripts before choosing a command; `ship`/`ship:cloudflare` create release artifacts and are not themselves proof of production deployment.

## Current known production issue

ImageForge PR #18 was merged at `0d983a86ae0291d18e2ab9cb47402afa3bb85b87`, with its exact-head verification and Chrome 80/80 evidence recorded in the control repository. However, production issue #17 remains open: the production `/service-worker.js` response had a cache header inconsistent with the expected `max-age=0` behavior. The source/preview assertion passing does not prove the production cache rule is fixed. The account-level Cloudflare cache configuration requires owner inspection.

## Maintenance workflow

1. Confirm the issue is a critical defect/security/availability fix within HOLD scope.
2. Check current issue/PR, branch and exact head; avoid duplicate work.
3. Install from lockfile and run the relevant unit/build/Chrome checks.
4. Verify offline/service-worker behavior, cache headers, image import/export and mobile layout as applicable.
5. Separate PR checks, Preview verification and production response evidence.
6. Do not change Cloudflare account rules or production settings without owner authorization.

## CI constraint

The owner confirmed GitHub Actions included minutes were exhausted at 12/12, expected to reset 2026-12-01. Avoid repeated workflow dispatches before reset or explicit owner authorization. Local verification can continue and must be labeled accurately.

This guide does not authorize feature expansion or production account changes.