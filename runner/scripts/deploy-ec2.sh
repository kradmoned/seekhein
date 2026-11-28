#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./runner/scripts/deploy-ec2.sh <EC2_IP> <SSH_KEY_PATH> <RUNNER_INTERNAL_KEY>

Example:
  ./runner/scripts/deploy-ec2.sh 52.64.178.42 ~/Downloads/seekkhein.pem "$(openssl rand -hex 32)"

Optional environment variables:
  SSH_USER                 Remote SSH user (default: ubuntu)
  RUNNER_DOMAIN            Public HTTPS hostname (default: <EC2_IP-with-dashes>.sslip.io)
  SANDBOX_MAX_CONCURRENT   Max concurrent sandbox containers (default: 2)
EOF
}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

EC2_IP="$1"
SSH_KEY_PATH="$2"
RUNNER_INTERNAL_KEY="$3"

SSH_USER="${SSH_USER:-ubuntu}"
RUNNER_DOMAIN="${RUNNER_DOMAIN:-${EC2_IP//./-}.sslip.io}"
SANDBOX_MAX_CONCURRENT="${SANDBOX_MAX_CONCURRENT:-2}"

if [[ -z "$EC2_IP" || "$EC2_IP" =~ [[:space:]] ]]; then
  echo "Error: invalid EC2_IP '$EC2_IP'" >&2
  exit 1
fi

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  echo "Error: SSH key not found at '$SSH_KEY_PATH'" >&2
  exit 1
fi

if [[ ! "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Error: invalid SSH_USER '$SSH_USER'" >&2
  exit 1
fi

if [[ ! "$RUNNER_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Error: invalid RUNNER_DOMAIN '$RUNNER_DOMAIN'" >&2
  exit 1
fi

if [[ ${#RUNNER_INTERNAL_KEY} -lt 16 || ! "$RUNNER_INTERNAL_KEY" =~ ^[A-Za-z0-9._~+-]+$ ]]; then
  echo "Error: RUNNER_INTERNAL_KEY must be at least 16 chars and match ^[A-Za-z0-9._~+-]+$" >&2
  exit 1
fi

if [[ ! "$SANDBOX_MAX_CONCURRENT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: SANDBOX_MAX_CONCURRENT must be a positive integer" >&2
  exit 1
fi

for cmd in go make ssh scp curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found in PATH" >&2
    exit 1
  fi
done

chmod 600 "$SSH_KEY_PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_PATH="$RUNNER_DIR/bin/coderunner-linux-amd64"

echo "==> [1/4] Building Linux amd64 runner binary..."
make -C "$RUNNER_DIR" build-linux

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "Error: expected binary missing at '$BINARY_PATH'" >&2
  exit 1
fi

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
)

echo "==> [2/4] Uploading binary to ${SSH_USER}@${EC2_IP}..."
scp "${SSH_OPTS[@]}" "$BINARY_PATH" "${SSH_USER}@${EC2_IP}:/tmp/coderunner.new"

echo "==> [3/4] Provisioning EC2 instance and starting coderunner + Caddy..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${EC2_IP}" \
  "sudo bash -s -- '$SSH_USER' '$RUNNER_DOMAIN' '$RUNNER_INTERNAL_KEY' '$SANDBOX_MAX_CONCURRENT'" <<'REMOTE_EOF'
set -euo pipefail

TARGET_USER="$1"
RUNNER_DOMAIN="$2"
RUNNER_INTERNAL_KEY="$3"
SANDBOX_MAX_CONCURRENT="$4"

# 1. Add 2 GB swap on small instances if no swap is active
if [[ ! -f /swapfile ]] && [[ -z "$(swapon --show --noheadings)" ]]; then
  echo "--> Creating 2 GB swapfile..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# 2. Install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "--> Installing Docker..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io
fi
systemctl enable --now docker
usermod -aG docker "$TARGET_USER" || true

# 3. Install Caddy if missing
if ! command -v caddy >/dev/null 2>&1; then
  echo "--> Installing Caddy..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  mkdir -p /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# 4. Install runner binary atomically
install -m 0755 /tmp/coderunner.new /usr/local/bin/coderunner
rm -f /tmp/coderunner.new

# 5. Write systemd unit for coderunner
cat > /etc/systemd/system/coderunner.service <<EOF
[Unit]
Description=Seekkhein Python Code Runner
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=${TARGET_USER}
Group=docker
Environment="RUNNER_ADDR=127.0.0.1:8081"
Environment="SANDBOX_AUTO_BUILD=true"
Environment="SANDBOX_MAX_CONCURRENT=${SANDBOX_MAX_CONCURRENT}"
ExecStart=/usr/local/bin/coderunner
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable coderunner
systemctl restart coderunner

# 6. Wait for coderunner (first boot pulls python:3.12-slim and builds sandbox image)
echo "--> Waiting for coderunner on 127.0.0.1:8081 (first boot builds sandbox image)..."
healthy=false
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8081/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 3
done

if [[ "$healthy" != "true" ]]; then
  echo "Error: coderunner failed to become healthy. Recent logs:" >&2
  journalctl -u coderunner -n 40 --no-pager >&2 || true
  exit 1
fi

# 7. Configure Caddy with automatic HTTPS + X-Internal-Key enforcement
cat > /etc/caddy/Caddyfile <<EOF
${RUNNER_DOMAIN} {
    @health path /health
    handle @health {
        reverse_proxy 127.0.0.1:8081
    }

    @authorized header X-Internal-Key ${RUNNER_INTERNAL_KEY}
    handle @authorized {
        reverse_proxy 127.0.0.1:8081
    }

    respond "Unauthorized" 401
}
EOF

chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy
REMOTE_EOF

echo "==> [4/4] Verifying public HTTPS endpoint (${RUNNER_DOMAIN})..."
https_ready=false
for _ in $(seq 1 15); do
  if curl -sf "https://${RUNNER_DOMAIN}/health" >/dev/null; then
    https_ready=true
    break
  fi
  sleep 3
done

if [[ "$https_ready" != "true" ]]; then
  echo "Error: https://${RUNNER_DOMAIN}/health did not respond over HTTPS in time." >&2
  echo "Check EC2 Security Group ports 80 & 443 and inspect Caddy logs:" >&2
  echo "  ssh -i $SSH_KEY_PATH ${SSH_USER}@${EC2_IP} 'sudo journalctl -u caddy -n 40 --no-pager'" >&2
  exit 1
fi

UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${RUNNER_DOMAIN}/run")"
if [[ "$UNAUTH_CODE" != "401" ]]; then
  echo "Error: expected HTTP 401 without X-Internal-Key, got HTTP ${UNAUTH_CODE}" >&2
  exit 1
fi

RUN_PAYLOAD='{"code":"def add(a, b):\n    return a + b\n","tests":"import unittest\nfrom solution import add\n\nclass SmokeTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n"}'
RUN_RESPONSE="$(curl -s -w '\n%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Key: ${RUNNER_INTERNAL_KEY}" \
  -d "$RUN_PAYLOAD" \
  "https://${RUNNER_DOMAIN}/run?view=student")"
RUN_CODE="$(printf '%s\n' "$RUN_RESPONSE" | tail -n1)"
RUN_BODY="$(printf '%s\n' "$RUN_RESPONSE" | sed '$d')"

if [[ "$RUN_CODE" != "200" ]] || [[ "$RUN_BODY" != *'"passed":1'* ]]; then
  echo "Error: smoke test failed (HTTP ${RUN_CODE}): ${RUN_BODY}" >&2
  exit 1
fi

cat <<EOF

Deployment complete!

Verified:
  - GET  https://${RUNNER_DOMAIN}/health -> 200 OK
  - POST https://${RUNNER_DOMAIN}/run (no key) -> 401 Unauthorized
  - POST https://${RUNNER_DOMAIN}/run?view=student (with key) -> 200 OK (passed: 1)

Set these Environment Variables in your Vercel backend project, then redeploy:
  RUNNER_URL=https://${RUNNER_DOMAIN}
  RUNNER_INTERNAL_KEY=${RUNNER_INTERNAL_KEY}
EOF
