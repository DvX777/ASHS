#!/bin/bash
# scripts/setup-hdd.sh
# Format and mount the 21TB HDD at /mnt/media.
# Run ONCE on first setup. Destructive!
set -euo pipefail

echo "=== HDD Setup for ASHS ==="
echo "This will FORMAT and mount your HDD at /mnt/media."
echo "Only run this on a fresh/unused disk!"
echo ""

# Detect the large disk (21TB ~ 21000GB)
HDD=$(lsblk -bnd -o NAME,SIZE | awk '$2 > 15000000000000 {print "/dev/"$1}' | head -1)

if [ -z "$HDD" ]; then
  echo "ERROR: Could not auto-detect HDD > 15TB. List your disks with: lsblk"
  echo "Then run manually: mkfs.ext4 /dev/sdX && mount /dev/sdX /mnt/media"
  exit 1
fi

echo "Detected HDD: $HDD"
echo "Size: $(lsblk -nd -o SIZE $HDD)"
read -p "Format $HDD as ext4 and mount at /mnt/media? [yes/NO] " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 0; }

echo "Partitioning..."
parted -s $HDD mklabel gpt mkpart primary ext4 0% 100%
PART="${HDD}1"
sleep 2

echo "Formatting as ext4 (this takes ~5 min for 21TB)..."
mkfs.ext4 -L ashs-media -m 0 $PART

echo "Mounting..."
mkdir -p /mnt/media
mount $PART /mnt/media

UUID=$(blkid -s UUID -o value $PART)
echo "Adding to /etc/fstab for auto-mount on reboot..."
echo "UUID=$UUID  /mnt/media  ext4  defaults,noatime  0  2" >> /etc/fstab

mkdir -p /mnt/media/movie /mnt/media/tv
echo ""
echo "✅ HDD mounted at /mnt/media"
df -h /mnt/media