#!/bin/bash
# scripts/setup-github-runner.sh
# Installs a GitHub self-hosted runner on the Dedi.
# This makes GitHub Actions FREE — it runs on your own server.
#
# Usage:
#   1. Go to: https://github.com/<your-username>/MoviesDB/settings/actions/runners/new
#   2. Copy the token shown on that page
#   3. Run: bash scripts/setup-github-runner.sh <YOUR_GITHUB_TOKEN>
set -euo pipefail

REPO_URL="https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]//' | sed 's/.git$//')"
TOKEN="${1:-}"
RUNNER_DIR="/opt/github-runner"
RUNNER_VERSION="2.319.1"

if [ -z "$TOKEN" ]; then
  echo "Usage: bash scripts/setup-github-runner.sh <REGISTRATION_TOKEN>"
  echo ""
  echo "Get the token from:"
  echo "  ${REPO_URL}/settings/actions/runners/new?runnerOs=linux"
  exit 1
fi

echo "=== Installing GitHub Self-Hosted Runner ==="
echo "Repo: ${REPO_URL}"
echo ""

mkdir -p $RUNNER_DIR
cd $RUNNER_DIR

echo "[1/4] Downloading runner..."
curl -sL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" | tar xz

echo "[2/4] Configuring runner..."
./config.sh \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "ashs-dedi" \
  --labels "self-hosted,linux,x64,ashs-dedi" \
  --work "/opt/ashs" \
  --unattended \
  --replace

echo "[3/4] Installing as systemd service..."
./svc.sh install
./svc.sh start

echo "[4/4] Verifying..."
./svc.sh status

echo ""
echo "✅ Self-hosted runner installed!"
echo "   It will now appear in GitHub → Settings → Actions → Runners"
echo "   Every push to 'main' will auto-deploy ASHS."
echo ""
echo "   Useful commands:"
echo "     Status:  cd $RUNNER_DIR && ./svc.sh status"
echo "     Logs:    journalctl -u actions.runner.*.ashs-dedi -f"
echo "     Stop:    cd $RUNNER_DIR && ./svc.sh stop"