#!/usr/bin/env bash
# scripts/link-ashs-to-radarr.sh - Bridge ASHS /mnt/media/movie/[TMDB] to Radarr /mnt/media/movies/[Title]
set -e

cd /opt/ashs

echo "====================================================="
echo " Bridging ASHS /mnt/media/movie to Radarr /mnt/media/movies"
echo " (Target: 20TB HDD /mnt/media - 0 bytes on NVMe)"
echo "====================================================="

bun run scripts/link-ashs-to-radarr.ts

echo ""
echo "====================================================="
echo " Bridge & library registration complete!"
echo " Radarr will link and monitor all 411 movies."
echo "====================================================="
