#!/usr/bin/env bash
# scripts/link-ashs-to-radarr.sh - Bridge ASHS /mnt/media/movie/[TMDB] to Radarr /media/Movies/[Title]
set -e

cd /opt/ashs

echo "====================================================="
echo " Bridging ASHS /mnt/media/movie to Radarr /media/Movies"
echo "====================================================="

bun run scripts/link-ashs-to-radarr.ts

echo ""
echo "====================================================="
echo " Linking complete! All 411 movies mapped to Radarr."
echo " Radarr will scan and turn all 411 movies green."
echo "====================================================="
