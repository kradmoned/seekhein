#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-ec2.sh <EC2_IP> <SSH_KEY_PATH>

Required environment variables:
  RUNNER_INTERNAL_KEY      Shared secret for runner X-Internal-Key (>=16 chars, [A-Za-z0-9._~+-])
  TUTOR_API_TOKEN          Bearer token for tutor API (>=16 chars, [A-Za-z0-9._~+-])
  OPENROUTER_API_KEY       OpenRouter API key for ai-server
  OPENROUTER_MODEL         OpenRouter model slug (e.g. openai/gpt-4o-mini)

Optional environment variables:
  SSH_USER                 Remote SSH user (default: ubuntu)
  RUNNER_DOMAIN            Runner HTTPS hostname (default: <EC2_IP-with-dashes>.sslip.io)
  TUTOR_DOMAIN             Tutor HTTPS hostname (default: tutor.<EC2_IP-with-dashes>.sslip.io)
  SANDBOX_MAX_CONCURRENT   Max concurrent sandbox containers (default: 2)
  ENABLE_RAG               Enable RAG extras on ai-server: true|false (default: false)
  MAX_HISTORY_TURNS        Max recent turns sent to LLM per request (default: 6)
  SKIP_LLM_SMOKE           Skip live OpenRouter call in smoke test: true|false (default: false)

Example:
  RUNNER_INTERNAL_KEY="$(openssl rand -hex 32)" \
  TUTOR_API_TOKEN="$(openssl rand -hex 32)" \
  OPENROUTER_API_KEY="sk-or-v1-..." \
  OPENROUTER_MODEL="openai/gpt-4o-mini" \
  ./scripts/deploy-ec2.sh 52.64.178.42 ~/Downloads/seekkhein.pem
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 1
fi

EC2_IP="$1"
SSH_KEY_PATH="$2"

RUNNER_INTERNAL_KEY="${RUNNER_INTERNAL_KEY:-}"
TUTOR_API_TOKEN="${TUTOR_API_TOKEN:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
OPENROUTER_MODEL="${OPENROUTER_MODEL:-}"

SSH_USER="${SSH_USER:-ubuntu}"
RUNNER_DOMAIN="${RUNNER_DOMAIN:-${EC2_IP//./-}.sslip.io}"
TUTOR_DOMAIN="${TUTOR_DOMAIN:-tutor.${EC2_IP//./-}.sslip.io}"
SANDBOX_MAX_CONCURRENT="${SANDBOX_MAX_CONCURRENT:-2}"
ENABLE_RAG="${ENABLE_RAG:-false}"
MAX_HISTORY_TURNS="${MAX_HISTORY_TURNS:-6}"
SKIP_LLM_SMOKE="${SKIP_LLM_SMOKE:-false}"

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

if [[ ! "$TUTOR_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Error: invalid TUTOR_DOMAIN '$TUTOR_DOMAIN'" >&2
  exit 1
fi

if [[ "$TUTOR_DOMAIN" == "$RUNNER_DOMAIN" ]]; then
  echo "Error: TUTOR_DOMAIN and RUNNER_DOMAIN must be different hostnames" >&2
  exit 1
fi

if [[ ${#RUNNER_INTERNAL_KEY} -lt 16 || ! "$RUNNER_INTERNAL_KEY" =~ ^[A-Za-z0-9._~+-]+$ ]]; then
  echo "Error: RUNNER_INTERNAL_KEY must be at least 16 chars and match ^[A-Za-z0-9._~+-]+$" >&2
  exit 1
fi

if [[ ${#TUTOR_API_TOKEN} -lt 16 || ! "$TUTOR_API_TOKEN" =~ ^[A-Za-z0-9._~+-]+$ ]]; then
  echo "Error: TUTOR_API_TOKEN must be at least 16 chars and match ^[A-Za-z0-9._~+-]+$" >&2
  exit 1
fi

if [[ -z "$OPENROUTER_API_KEY" || "$OPENROUTER_API_KEY" == *$'\n'* || "$OPENROUTER_API_KEY" == *$'\r'* ]]; then
  echo "Error: OPENROUTER_API_KEY must be non-empty and contain no newlines" >&2
  exit 1
fi

if [[ -z "$OPENROUTER_MODEL" || "$OPENROUTER_MODEL" == *$'\n'* || "$OPENROUTER_MODEL" == *$'\r'* ]]; then
  echo "Error: OPENROUTER_MODEL must be non-empty and contain no newlines" >&2
  exit 1
fi

if [[ ! "$SANDBOX_MAX_CONCURRENT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: SANDBOX_MAX_CONCURRENT must be a positive integer" >&2
  exit 1
fi

if [[ "$ENABLE_RAG" != "true" && "$ENABLE_RAG" != "false" ]]; then
  echo "Error: ENABLE_RAG must be 'true' or 'false'" >&2
  exit 1
fi

if [[ ! "$MAX_HISTORY_TURNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: MAX_HISTORY_TURNS must be a positive integer" >&2
  exit 1
fi

if [[ "$SKIP_LLM_SMOKE" != "true" && "$SKIP_LLM_SMOKE" != "false" ]]; then
  echo "Error: SKIP_LLM_SMOKE must be 'true' or 'false'" >&2
  exit 1
fi

for cmd in go make tar ssh scp curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found in PATH" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER_DIR="$REPO_ROOT/runner"
AI_SERVER_DIR="$REPO_ROOT/ai-server"
BINARY_PATH="$RUNNER_DIR/bin/coderunner-linux-amd64"

if [[ ! -d "$RUNNER_DIR" || ! -d "$AI_SERVER_DIR" ]]; then
  echo "Error: expected runner/ and ai-server/ directories under '$REPO_ROOT'" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

echo "==> [1/5] Building runner binary and packaging ai-server..."
make -C "$RUNNER_DIR" build-linux

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "Error: expected binary missing at '$BINARY_PATH'" >&2
  exit 1
fi

COPYFILE_DISABLE=1 tar -czf "$STAGING_DIR/ai-server.tar.gz" \
  --exclude='.venv' \
  --exclude='.pytest_cache' \
  --exclude='__pycache__' \
  --exclude='.env' \
  --exclude='data' \
  --exclude='chroma_db' \
  --exclude='*.pyc' \
  --exclude='.DS_Store' \
  -C "$AI_SERVER_DIR" .

umask 077
{
  printf 'TARGET_USER=%q\n' "$SSH_USER"
  printf 'RUNNER_DOMAIN=%q\n' "$RUNNER_DOMAIN"
  printf 'TUTOR_DOMAIN=%q\n' "$TUTOR_DOMAIN"
  printf 'RUNNER_INTERNAL_KEY=%q\n' "$RUNNER_INTERNAL_KEY"
  printf 'TUTOR_API_TOKEN=%q\n' "$TUTOR_API_TOKEN"
  printf 'OPENROUTER_API_KEY=%q\n' "$OPENROUTER_API_KEY"
  printf 'OPENROUTER_MODEL=%q\n' "$OPENROUTER_MODEL"
  printf 'SANDBOX_MAX_CONCURRENT=%q\n' "$SANDBOX_MAX_CONCURRENT"
  printf 'ENABLE_RAG=%q\n' "$ENABLE_RAG"
  printf 'MAX_HISTORY_TURNS=%q\n' "$MAX_HISTORY_TURNS"
} > "$STAGING_DIR/deploy.env"
chmod 600 "$STAGING_DIR/deploy.env"

chmod 600 "$SSH_KEY_PATH"

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
)

echo "==> [2/5] Uploading artifacts to ${SSH_USER}@${EC2_IP}..."
scp "${SSH_OPTS[@]}" \
  "$BINARY_PATH" \
  "${SSH_USER}@${EC2_IP}:/tmp/coderunner.new"
scp "${SSH_OPTS[@]}" \
  "$STAGING_DIR/ai-server.tar.gz" \
  "${SSH_USER}@${EC2_IP}:/tmp/ai-server.tar.gz"
scp "${SSH_OPTS[@]}" \
  "$STAGING_DIR/deploy.env" \
  "${SSH_USER}@${EC2_IP}:/tmp/seekhein-deploy.env"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${EC2_IP}" "chmod 600 /tmp/seekhein-deploy.env"

echo "==> [3/5] Provisioning EC2 and starting coderunner, seekhein-tutor, and Caddy..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${EC2_IP}" "sudo bash -s" <<'REMOTE_EOF'
set -euo pipefail

remote_cleanup() {
  rm -f /tmp/seekhein-deploy.env /tmp/coderunner.new /tmp/ai-server.tar.gz
}
trap remote_cleanup EXIT

if [[ ! -f /tmp/seekhein-deploy.env ]]; then
  echo "Error: missing /tmp/seekhein-deploy.env on remote host" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /tmp/seekhein-deploy.env

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [[ -z "$TARGET_HOME" || ! -d "$TARGET_HOME" ]]; then
  echo "Error: could not resolve home directory for '$TARGET_USER'" >&2
  exit 1
fi

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

# 4. Install and start coderunner
install -m 0755 /tmp/coderunner.new /usr/local/bin/coderunner

cat > /etc/systemd/system/coderunner.service <<EOF
[Unit]
Description=Seekhein Python Code Runner
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

# 5. Install and start seekhein-tutor (ai-server)
rm -rf /opt/ai-server.new
mkdir -p /opt/ai-server.new
tar -xzf /tmp/ai-server.tar.gz -C /opt/ai-server.new
if [[ -d /opt/ai-server/chroma_db ]]; then
  mv /opt/ai-server/chroma_db /opt/ai-server.new/chroma_db
fi
if [[ -d /opt/ai-server/data ]]; then
  mv /opt/ai-server/data /opt/ai-server.new/data
fi
rm -rf /opt/ai-server
mv /opt/ai-server.new /opt/ai-server
mkdir -p /opt/ai-server/data
chown -R "$TARGET_USER:$TARGET_USER" /opt/ai-server

UV_BIN=""
if command -v uv >/dev/null 2>&1; then
  UV_BIN="$(command -v uv)"
elif [[ -x "${TARGET_HOME}/.local/bin/uv" ]]; then
  UV_BIN="${TARGET_HOME}/.local/bin/uv"
else
  echo "--> Installing uv for ${TARGET_USER}..."
  sudo -u "$TARGET_USER" env HOME="$TARGET_HOME" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  UV_BIN="${TARGET_HOME}/.local/bin/uv"
fi

echo "--> Syncing ai-server dependencies (ENABLE_RAG=${ENABLE_RAG})..."
if [[ "$ENABLE_RAG" == "true" ]]; then
  sudo -u "$TARGET_USER" env HOME="$TARGET_HOME" bash -lc "cd /opt/ai-server && '$UV_BIN' sync --frozen --extra rag"
else
  sudo -u "$TARGET_USER" env HOME="$TARGET_HOME" bash -lc "cd /opt/ai-server && '$UV_BIN' sync --frozen"
fi

umask 077
{
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
  printf 'OPENROUTER_MODEL=%s\n' "$OPENROUTER_MODEL"
  printf 'ENABLE_RAG=%s\n' "$ENABLE_RAG"
  printf 'SESSION_DB_PATH=%s\n' "/opt/ai-server/data/sessions.db"
  printf 'MAX_HISTORY_TURNS=%s\n' "$MAX_HISTORY_TURNS"
} > /etc/seekhein-tutor.env
chown root:root /etc/seekhein-tutor.env
chmod 600 /etc/seekhein-tutor.env
umask 022

cat > /etc/systemd/system/seekhein-tutor.service <<EOF
[Unit]
Description=Seekhein Socratic AI Tutor Server
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=/opt/ai-server
EnvironmentFile=/etc/seekhein-tutor.env
ExecStart=/opt/ai-server/.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable seekhein-tutor
systemctl restart seekhein-tutor

# 6. Wait for local health checks
echo "--> Waiting for coderunner on 127.0.0.1:8081..."
runner_healthy=false
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8081/health >/dev/null; then
    runner_healthy=true
    break
  fi
  sleep 3
done

if [[ "$runner_healthy" != "true" ]]; then
  echo "Error: coderunner failed to become healthy. Recent logs:" >&2
  journalctl -u coderunner -n 40 --no-pager >&2 || true
  exit 1
fi

echo "--> Waiting for seekhein-tutor on 127.0.0.1:8000..."
tutor_healthy=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null; then
    tutor_healthy=true
    break
  fi
  sleep 2
done

if [[ "$tutor_healthy" != "true" ]]; then
  echo "Error: seekhein-tutor failed to become healthy. Recent logs:" >&2
  journalctl -u seekhein-tutor -n 40 --no-pager >&2 || true
  exit 1
fi

# 7. Configure modular Caddy with automatic HTTPS + edge auth
mkdir -p /etc/caddy/conf.d

cat > /etc/caddy/Caddyfile <<'EOF'
import /etc/caddy/conf.d/*.caddy
EOF

cat > /etc/caddy/conf.d/runner.caddy <<EOF
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

cat > /etc/caddy/conf.d/tutor.caddy <<EOF
${TUTOR_DOMAIN} {
    @health path /health
    handle @health {
        reverse_proxy 127.0.0.1:8000
    }

    @authorized header Authorization "Bearer ${TUTOR_API_TOKEN}"
    handle @authorized {
        reverse_proxy 127.0.0.1:8000
    }

    respond "Unauthorized" 401
}
EOF

chown root:caddy /etc/caddy/Caddyfile /etc/caddy/conf.d /etc/caddy/conf.d/runner.caddy /etc/caddy/conf.d/tutor.caddy
chmod 750 /etc/caddy/conf.d
chmod 640 /etc/caddy/Caddyfile /etc/caddy/conf.d/runner.caddy /etc/caddy/conf.d/tutor.caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy
REMOTE_EOF

echo "==> [4/5] Verifying Runner HTTPS endpoint (${RUNNER_DOMAIN})..."
runner_https_ready=false
for _ in $(seq 1 15); do
  if curl -sf "https://${RUNNER_DOMAIN}/health" >/dev/null; then
    runner_https_ready=true
    break
  fi
  sleep 3
done

if [[ "$runner_https_ready" != "true" ]]; then
  echo "Error: https://${RUNNER_DOMAIN}/health did not respond over HTTPS in time." >&2
  echo "Check EC2 Security Group ports 80 & 443 and inspect Caddy logs:" >&2
  echo "  ssh -i $SSH_KEY_PATH ${SSH_USER}@${EC2_IP} 'sudo journalctl -u caddy -n 40 --no-pager'" >&2
  exit 1
fi

RUNNER_UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${RUNNER_DOMAIN}/run")"
if [[ "$RUNNER_UNAUTH_CODE" != "401" ]]; then
  echo "Error: expected HTTP 401 without X-Internal-Key, got HTTP ${RUNNER_UNAUTH_CODE}" >&2
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
  echo "Error: runner smoke test failed (HTTP ${RUN_CODE}): ${RUN_BODY}" >&2
  exit 1
fi

echo "==> [5/5] Verifying Tutor HTTPS endpoint (${TUTOR_DOMAIN})..."
tutor_https_ready=false
for _ in $(seq 1 15); do
  if curl -sf "https://${TUTOR_DOMAIN}/health" >/dev/null; then
    tutor_https_ready=true
    break
  fi
  sleep 3
done

if [[ "$tutor_https_ready" != "true" ]]; then
  echo "Error: https://${TUTOR_DOMAIN}/health did not respond over HTTPS in time." >&2
  echo "Check EC2 Security Group ports 80 & 443 and inspect Caddy logs:" >&2
  echo "  ssh -i $SSH_KEY_PATH ${SSH_USER}@${EC2_IP} 'sudo journalctl -u caddy -n 40 --no-pager'" >&2
  exit 1
fi

TUTOR_UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${TUTOR_DOMAIN}/api/v1/tutor")"
if [[ "$TUTOR_UNAUTH_CODE" != "401" ]]; then
  echo "Error: expected HTTP 401 without Bearer token on tutor endpoint, got HTTP ${TUTOR_UNAUTH_CODE}" >&2
  exit 1
fi

if [[ "$SKIP_LLM_SMOKE" == "true" ]]; then
  TUTOR_AUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TUTOR_API_TOKEN}" \
    -d '{}' \
    "https://${TUTOR_DOMAIN}/api/v1/tutor")"
  if [[ "$TUTOR_AUTH_CODE" != "422" ]]; then
    echo "Error: expected HTTP 422 on empty authorized tutor payload, got HTTP ${TUTOR_AUTH_CODE}" >&2
    exit 1
  fi
  TUTOR_SMOKE_NOTE="POST https://${TUTOR_DOMAIN}/api/v1/tutor (with token, empty payload) -> 422 (SKIP_LLM_SMOKE=true)"
else
  TUTOR_PAYLOAD='{"conversation_id":"deploy-smoke-1","message":"Why does my loop only return the first number?","recent_messages":[],"current_code":"def first(nums):\n    for n in nums:\n        return n","executed_code":null,"output_error":null,"validation_feedback":null}'
  TUTOR_RESPONSE="$(curl -s -w '\n%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TUTOR_API_TOKEN}" \
    -d "$TUTOR_PAYLOAD" \
    "https://${TUTOR_DOMAIN}/api/v1/tutor")"
  TUTOR_CODE="$(printf '%s\n' "$TUTOR_RESPONSE" | tail -n1)"
  TUTOR_BODY="$(printf '%s\n' "$TUTOR_RESPONSE" | sed '$d')"

  if [[ "$TUTOR_CODE" != "200" ]] || [[ "$TUTOR_BODY" != *'"status":"success"'* ]]; then
    echo "Error: tutor smoke test failed (HTTP ${TUTOR_CODE}): ${TUTOR_BODY}" >&2
    exit 1
  fi
  TUTOR_SMOKE_NOTE="POST https://${TUTOR_DOMAIN}/api/v1/tutor (with token) -> 200 OK (status: success)"
fi

cat <<EOF

Deployment complete!

Verified:
  - GET  https://${RUNNER_DOMAIN}/health -> 200 OK
  - POST https://${RUNNER_DOMAIN}/run (no key) -> 401 Unauthorized
  - POST https://${RUNNER_DOMAIN}/run?view=student (with key) -> 200 OK (passed: 1)
  - GET  https://${TUTOR_DOMAIN}/health -> 200 OK
  - POST https://${TUTOR_DOMAIN}/api/v1/tutor (no token) -> 401 Unauthorized
  - ${TUTOR_SMOKE_NOTE}

Set these Environment Variables in your Vercel backend project, then redeploy:
  RUNNER_URL=https://${RUNNER_DOMAIN}
  RUNNER_INTERNAL_KEY=${RUNNER_INTERNAL_KEY}
  TUTOR_API_URL=https://${TUTOR_DOMAIN}
  TUTOR_API_TOKEN=${TUTOR_API_TOKEN}
EOF
