# ASHS Deployment Guide

## Overview

ASHS uses GitHub Actions with a **self-hosted runner** on the Dedi for CI/CD.  
This means deployments are completely **FREE** — GitHub Actions minutes are only charged for GitHub-hosted runners.

## Architecture

```
Push to main
    │
    ▼
GitHub Actions (deploy.yml)
    │ runs on
    ▼
Self-Hosted Runner (installed on Dedi)
    │
    ├── bun install
    ├── bun run migrate
    ├── systemctl restart ashs
    └── curl /health → verify
```

## First-Time Dedi Setup

### Step 1 — Upload project
```bash
# From your Windows machine:
scp -r "C:\Project\MoviesDB" root@<DEDI_IP>:/opt/ashs
ssh root@<DEDI_IP>
cd /opt/ashs
```

### Step 2 — Run deploy script
```bash
bash scripts/deploy.sh
```

### Step 3 — Configure environment
```bash
cp .env.example .env
nano .env
# Fill in:
#   DB_PATH=/opt/ashs/db/ashs.sqlite3
#   TEMP_DIR=/opt/ashs/temp
#   MEDIA_DIR=/mnt/media
#   TMDB_API_KEY=<your key>
#   ADMIN_API_KEY=<generate: openssl rand -hex 32>
#   DISCORD_WEBHOOK_URL=<optional>
#   CORS_ORIGINS=https://vidzen.fun
```

### Step 4 — Setup HDD (if not already formatted)
```bash
bash scripts/setup-hdd.sh
```

### Step 5 — Run initial migration + seed
```bash
DB_PATH=/opt/ashs/db/ashs.sqlite3 bun run scripts/migrate.ts
DB_PATH=/opt/ashs/db/ashs.sqlite3 bun run scripts/seed-site.ts vidzen.fun "Vidzen"
```

### Step 6 — Import existing Jellyfin/Radarr library (optional)
```bash
MEDIA_DIR=/mnt/media DB_PATH=/opt/ashs/db/ashs.sqlite3 \
  bun run scripts/import-library.ts /old/jellyfin/Movies --move
```

### Step 7 — Setup CF Tunnel
```bash
bash scripts/setup-tunnel.sh
```

### Step 8 — Install GitHub self-hosted runner
```bash
# Get your registration token from:
# https://github.com/<you>/MoviesDB/settings/actions/runners/new
bash scripts/setup-github-runner.sh <REGISTRATION_TOKEN>
```

### Step 9 — Start ASHS
```bash
systemctl start ashs
journalctl -u ashs -f
```

### Step 10 — Verify
```bash
curl https://primeshow.online/health
```

---

## GitHub Repository Secrets

Add these in: **GitHub → Repo → Settings → Secrets → Actions**

| Secret | Value |
|---|---|
| `TMDB_API_KEY` | Your TMDB API key |
| `DISCORD_WEBHOOK_URL` | Discord webhook (optional) |

The `.env` file on the Dedi holds the rest (admin key, etc.) and is **never committed**.

---

## Deploy Flow (after setup)

```bash
# Normal development workflow:
git add .
git commit -m "feat: add something"
git push origin main
# → GitHub detects push
# → Runs deploy.yml on your Dedi runner
# → Auto restarts ASHS
# → Health check confirms deploy
```

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production — auto-deploys to Dedi |
| `develop` | Development — runs tests only |

## Useful Commands on Dedi

```bash
# View live logs
journalctl -u ashs -f

# Restart manually
systemctl restart ashs

# Check status
systemctl status ashs

# View runner logs
journalctl -u actions.runner.*.ashs-dedi -f

# Check disk
df -h /mnt/media

# DB size
ls -lh /opt/ashs/db/

# Library stats
curl http://localhost:4000/health | python3 -m json.tool
```