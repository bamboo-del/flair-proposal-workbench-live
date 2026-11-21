#!/usr/bin/env bash
set -euo pipefail
umask 077

release=$(realpath -e "${1:?Usage: bash deploy/aliyun.sh /opt/flair-proposal/releases/RELEASE}")
case "$release" in
  /opt/flair-proposal/releases/*) ;;
  *) echo "Release must be under /opt/flair-proposal/releases" >&2; exit 1 ;;
esac

root=/opt/flair-proposal
env_file=$root/shared/app.env
site=flair.yisonglian.cn
caddy=scan-wifi-production-caddy-1
caddyfile=/opt/scan-wifi-releases/20261012-team/deploy/Caddyfile
edge=scan-wifi-production_edge
begin='# BEGIN flair-proposal'
proxy='  reverse_proxy flair-proposal-web:3000'

test "$(stat -c '%a:%u' "$env_file")" = '600:0'
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$caddy")" = "$caddyfile"
docker network inspect "$edge" >/dev/null

get() { curl -fsS --connect-timeout 4 --max-time 12 -o /dev/null "$1"; }
check_existing() {
  get https://api.yisonglian.cn/health &&
    get https://admin.yisonglian.cn/ &&
    get https://classflow.yisonglian.cn/
}

check_existing
echo 'Existing HTTPS health checks passed before deploy.'

compose=(docker compose -p flair-proposal -f "$release/deploy/compose.aliyun.yaml")
"${compose[@]}" up -d --build --wait --wait-timeout 120
"${compose[@]}" exec -T web node -e "fetch('http://127.0.0.1:3000/roadshow').then(r=>process.exit(r.ok && r.headers.get('content-type')?.includes('text/html') ? 0 : 1)).catch(()=>process.exit(1))"

install -d -m 0700 "$root/shared"
exec 9>/run/lock/flair-proposal-caddy.lock
flock 9
if grep -Fq "$site" "$caddyfile"; then
  grep -Fxq "$begin" "$caddyfile" && grep -Fxq "$proxy" "$caddyfile" || {
    echo "Existing Caddy route requires review for $site" >&2
    exit 1
  }
else
  baseline=$(sha256sum "$caddyfile")
  backup=$(mktemp "$root/shared/Caddyfile.before-flair.XXXXXX")
  candidate=$(mktemp "$root/shared/Caddyfile.candidate.XXXXXX")
  trap 'rm -f -- "$candidate"' EXIT
  cat "$caddyfile" >"$backup"
  { cat "$backup"; printf '\n%s\n%s {\n%s\n}\n# END flair-proposal\n' "$begin" "$site" "$proxy"; } >"$candidate"
  docker exec -i "$caddy" caddy validate --config /dev/stdin --adapter caddyfile <"$candidate"
  test "$(sha256sum "$caddyfile")" = "$baseline"
  cat "$candidate" >"$caddyfile"
  if ! docker kill --signal=USR1 "$caddy" >/dev/null || ! (check_existing || (sleep 3 && check_existing)); then
    if cmp -s "$candidate" "$caddyfile"; then
      cat "$backup" >"$caddyfile"
      docker kill --signal=USR1 "$caddy" >/dev/null
    fi
    echo "Existing HTTPS health check failed during reload. Backup: $backup" >&2
    exit 1
  fi
  echo "Caddy backup retained at $backup."
fi
flock -u 9

for attempt in {1..18}; do
  if get "https://$site/healthz" && get "https://$site/roadshow"; then
    check_existing
    echo "HTTPS health checks passed for $site and the existing sites."
    exit 0
  fi
  sleep 5
done
echo "The app is healthy inside Docker. Public HTTPS is pending verification for $site." >&2
exit 1
