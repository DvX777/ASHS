# ASHS — Auto Self-Hosted System

A fully autonomous media library server that discovers, downloads, and serves movies and TV shows through a secure API.

## Stack

- **Runtime**: [Bun](https://bun.sh) (TypeScript)
- **API**: [Elysia](https://elysiajs.com) on `:4000`
- **File Server**: Elysia on `:4001` (byte-range streaming)
- **Database**: SQLite via `bun:sqlite`
- **Tunnel**: Cloudflare Tunnel (`cloudflared`)
- **Sources**: TMDB discovery + MovieBox resolver

## How It Works

```
TMDB trending/popular/classics
      |
      v
Discovery Scheduler (every 6h)
      |
      v
Download Manager (5 concurrent)
      |                  |
      v                  v
  MovieBox          TMDB metadata
  resolver          (poster, rating,
  (stream URL)       genres, overview)
      |
      v
NVMe temp (.part)
      |
      v
21TB HDD (/opt/ashs/media/)
      |
      v
File Server (:4001) + API (:4000)
      |
      v
CF Tunnel (primeshow.online)
```

## Setup

### 1. Prerequisites

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb
```

### 2. Clone and configure

```bash
git clone https://github.com/DvX777/ASHS /opt/ashs
cd /opt/ashs
cp .env.example .env
nano .env  # fill in your values
```

### 3. Install dependencies

```bash
bun install
```

### 4. Run database migrations

```bash
bun run scripts/migrate.ts
```

### 5. Add first approved site

```bash
bun run scripts/seed-site.ts yoursite.com "Site Name"
```

### 6. Setup systemd service

```bash
cp deploy/ashs.service /etc/systemd/system/
systemctl enable ashs
systemctl start ashs
```

### 7. Setup Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create ashs-primeshow
cloudflared route dns ashs-primeshow primeshow.online
cloudflared route dns ashs-primeshow stream.primeshow.online
cp config/cloudflared.yml /opt/ashs/config/
systemctl enable cloudflared
systemctl start cloudflared
```

### 8. Setup daily backup cron

```bash
(crontab -l 2>/dev/null; echo "0 2 * * * /root/.bun/bin/bun /opt/ashs/scripts/backup-db.ts >> /var/log/ashs/backup.log 2>&1") | crontab -
```

## API Authentication

### Admin routes (`/v1/admin/*`)

```
X-ASHS-Admin-Key: your_admin_api_key
```

### Library routes (`/v1/library/*`)

HMAC-SHA256 signed. Sign the **pathname only** (no query string):

```
message   = "METHOD:pathname:unix_timestamp"
signature = HMAC-SHA256(site_api_key, message)

Headers:
  X-ASHS-Site:      yoursite.com
  X-ASHS-Timestamp: 1725465600
  X-ASHS-Signature: <hex_signature>
```

## Key Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | System status |
| GET | `/v1/admin/health` | Admin | Detailed system health |
| GET | `/v1/admin/queue` | Admin | Download queue |
| POST | `/v1/admin/srr` | Admin | Trigger Smart Re-Resolve |
| POST | `/v1/admin/ingest` | Admin | Trigger discovery |
| GET | `/v1/library/movies` | HMAC | List ready movies |
| GET | `/v1/library/movies/:id` | HMAC | Movie detail + stream URL |
| GET | `/v1/library/tv` | HMAC | List ready TV shows |
| GET | `/v1/library/tv/:id/:season` | HMAC | Season episode list |
| GET | `/v1/library/search?q=` | HMAC | Full-text search |
| GET | `/v1/library/check/:id` | HMAC | Availability check |
| DELETE | `/v1/admin/media/:id` | Admin | Remove + delete from disk |

## SRR — Smart Re-Resolve

Runs on startup and every 6 hours. Automatically heals:

- **Zombie files** — re-queues incomplete downloads (auto-resumes `.part` files)
- **Ghost files** — re-downloads files missing from disk
- **Stale resolving** — resets shows stuck in resolving state
- **Orphan .part files** — cleans temp files from crashed downloads
- **Quality upgrades** — queues 1080p for movies that only have 720p

## Directory Structure

```
/opt/ashs/
  src/           TypeScript source
  scripts/       Utility scripts (migrate, seed, backup)
  config/        cloudflared.yml
  db/            SQLite database + backups
  media/         Downloaded MP4 files (21TB HDD)
  temp/          In-progress downloads (NVMe)
  logs/          Application logs
```

## License

Private — internal use only.
