#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-meridian.gmgn.online}"
EMAIL="${CERTBOT_EMAIL:-${EMAIL:-admin@example.com}}"
WEB_APP_NAME="${WEB_APP_NAME:-meteora-web}"
WEB_PORT="${WEB_PORT:-${PORT:-}}"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-meridian}"
NGINX_AVAILABLE="/etc/nginx/sites-available/${NGINX_SITE_NAME}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${NGINX_SITE_NAME}.conf"
ORIGINAL_ARGS=("$@")

usage() {
  cat <<'USAGE'
Usage:
  ./web.sh [--domain meridian.gmgn.online] [--email name@example.com] [--port 3000]

Environment overrides:
  DOMAIN, CERTBOT_EMAIL/EMAIL, WEB_PORT/PORT, PROJECT_DIR, WEB_APP_NAME, NGINX_SITE_NAME

This script:
  1. Detects the website port from --port/env/ecosystem.config.cjs/PM2, default 3000.
  2. Creates an Nginx reverse proxy for the domain.
  3. Requests and installs HTTPS via Certbot.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:?Missing value for --domain}"
      shift 2
      ;;
    --email)
      EMAIL="${2:?Missing value for --email}"
      shift 2
      ;;
    --port)
      WEB_PORT="${2:?Missing value for --port}"
      shift 2
      ;;
    --project-dir)
      PROJECT_DIR="${2:?Missing value for --project-dir}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi

  echo "This script must be run as root. Re-run with sudo." >&2
  exit 1
}

detect_port_from_ecosystem() {
  local ecosystem_file="${PROJECT_DIR}/ecosystem.config.cjs"

  if [[ ! -f "${ecosystem_file}" ]] || ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  node - "${ecosystem_file}" "${WEB_APP_NAME}" <<'NODE'
const ecosystemFile = process.argv[2];
const webAppName = process.argv[3];

try {
  const config = require(ecosystemFile);
  const apps = Array.isArray(config.apps) ? config.apps : [];
  const app = apps.find((candidate) => {
    const name = String(candidate.name ?? "");
    const script = String(candidate.script ?? "");
    return name === webAppName || /web/i.test(name) || /server\.mjs$/i.test(script);
  });
  const port = app?.env?.PORT ?? app?.env_production?.PORT ?? app?.env_development?.PORT;
  if (port) {
    process.stdout.write(String(port));
    process.exit(0);
  }
} catch {
}

process.exit(1);
NODE
}

detect_port_from_pm2() {
  if ! command -v pm2 >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  pm2 jlist 2>/dev/null | node - "${WEB_APP_NAME}" <<'NODE'
const webAppName = process.argv[2];
let input = "";

process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const apps = JSON.parse(input);
    const app = apps.find((candidate) => {
      const name = String(candidate.name ?? "");
      return name === webAppName || /web/i.test(name);
    });
    const port = app?.pm2_env?.env?.PORT ?? app?.pm2_env?.PORT;
    if (port) {
      process.stdout.write(String(port));
      process.exit(0);
    }
  } catch {
  }

  process.exit(1);
});
NODE
}

detect_web_port() {
  if [[ -n "${WEB_PORT}" ]]; then
    echo "${WEB_PORT}"
    return 0
  fi

  if detected_port="$(detect_port_from_ecosystem)"; then
    echo "${detected_port}"
    return 0
  fi

  if detected_port="$(detect_port_from_pm2)"; then
    echo "${detected_port}"
    return 0
  fi

  echo "3000"
}

install_dependencies() {
  if command -v nginx >/dev/null 2>&1 && command -v certbot >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "nginx/certbot not found and apt-get is unavailable. Install nginx, certbot, and python-certbot-nginx first." >&2
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nginx certbot python-certbot-nginx
}

validate_port() {
  local port="$1"

  if ! [[ "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Invalid website port: ${port}" >&2
    exit 1
  fi
}

write_nginx_site() {
  local port="$1"

  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

  cat > "${NGINX_AVAILABLE}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300;
        proxy_send_timeout 300;
    }
}
NGINX

  ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  nginx -t

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx
  else
    service nginx reload
  fi
}

allow_firewall_http_https() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi "Status: active"; then
    ufw allow "Nginx Full"
  fi
}

install_ssl() {
  certbot --nginx \
    --non-interactive \
    --agree-tos \
    --redirect \
    --email "${EMAIL}" \
    -d "${DOMAIN}"
}

main() {
  require_root "${ORIGINAL_ARGS[@]}"

  local web_port
  web_port="$(detect_web_port)"
  validate_port "${web_port}"

  echo "Domain        : ${DOMAIN}"
  echo "Email         : ${EMAIL}"
  echo "Website port  : ${web_port}"
  echo "Project dir   : ${PROJECT_DIR}"
  echo "Nginx site    : ${NGINX_AVAILABLE}"

  install_dependencies
  write_nginx_site "${web_port}"
  allow_firewall_http_https
  install_ssl

  echo
  echo "Done. Website should be available at https://${DOMAIN}"
}

main "$@"
