# Unified deployment registry — DevNervs

This repository documents the canonical Git-driven Cloudflare deployment flow for all Web projects. No `CLOUDFLARE_API_TOKEN`, `wrangler login`, or manual direct upload is required for ordinary production deployments.

| Project | Type | Repository | Branch | Production URL | Cloudflare project | Build command | Output | Redeploy trigger | Status |
|---|---|---|---|---|---|---|---|---|---|
| Spravno Web | Pages | [DevNervs/KMasterApp](https://github.com/DevNervs/KMasterApp) | `main` | https://spravno.pages.dev | `spravno` | `bash cloudflare-build.sh` in `web/` | `dist` | `web/.deploy/redeploy.txt` | Active |
| MS Design | Pages | [DevNervs/Site](https://github.com/DevNervs/Site) | `main` | https://msdesign-portfolio.pages.dev | `msdesign` | `bash cloudflare-build.sh` | `dist` | `.deploy/redeploy.txt` | Active |
| Emmanuel Next | Worker | [DevNervs/emmanuil-next](https://github.com/DevNervs/emmanuil-next) | `main` | https://app.boris-reminder.workers.dev / https://new.emmanuil.cv.ua | `app` | `bash cloudflare-build.sh` | `.open-next/worker.js` + `.open-next/assets` | `.deploy/redeploy.txt` | Active |

## How it works

1. Push or merge to the production branch of the repository.
2. Cloudflare Native Git Integration (Pages) or Cloudflare Workers Builds (Worker) runs the build gate.
3. Build artifacts are deployed to the production URL.

## No-code redeploy

Update the marker in the `.deploy/redeploy.txt` file listed above and push it to `main`. The file is inside the Cloudflare build watch path, so a new build is triggered without touching application code.

## Smoke procedure

After a successful build:

1. Open the production URL.
2. Verify it returns HTTP 200 and the latest commit is reflected.
3. Check the Cloudflare dashboard build logs for any failure.

## Legacy projects removed

The following Pages projects have been deleted after cutover:

- `emmanuil` (Direct Upload)
- `emmanuil-git` (legacy Git)
- `spravno-git` (duplicate Git)
- `spravno-web` (Direct Upload)
- `site-git` (duplicate Git)

## Agent note

When a user asks to deploy any of these projects, use the documented Git-driven path. Do not ask for or use a Cloudflare API token for ordinary production deployment.
