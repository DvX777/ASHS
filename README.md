# MoviesDB — ASHS (Auto Self-Hosted System)

Autonomous media library for movies & TV shows. Part of the Vidzen ecosystem.

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Copy and fill env
cp .env.example .env
nano .env

# 3. Run migrations
bun run migrate

# 4. Add an approved site
bun run scripts/seed-site.ts vidzen.fun "Vidzen"

# 5. Start (dev)
bun run dev

# 6. Start (production via PM2)
pm2 start ecosystem.config.js
```

## Services

| Service | Port | Purpose |
|---|---|---|
| API | 4000 | Library queries, admin |
| FileServer | 4001 | Raw file streaming |

## API

All endpoints: `https://primeshow.online/v1/...`

Requires HMAC authentication headers:
- `X-ASHS-Site: your-domain.com`
- `X-ASHS-Timestamp: <unix seconds>`
- `X-ASHS-Signature: <HMAC-SHA256>`

### Key endpoints
- `GET /health` — System health (public)
- `GET /v1/library/movies` — List movies
- `GET /v1/library/check/:tmdbId` — Check availability
- `GET /v1/stream/movie/:tmdbId?q=1080` — Stream file
- `POST /v1/admin/download` — Queue a specific title
