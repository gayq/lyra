#!/bin/bash

if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "bash is required!"
  exit 1
fi

set -euo pipefail
trap 'echo "[setup] error at line $LINENO: $BASH_COMMAND" >&2' ERR

AUTO_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--non-interactive)
      AUTO_YES=1
      ;;
  esac
done

log() {
  echo "[setup] $*"
}

retry() {
  local attempts="$1"
  shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      return 1
    fi
    n=$((n + 1))
    sleep 2
  done
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "$cmd is required but was not found!"
    exit 1
  fi
}

case "$(uname -s)" in
  Linux) ;;
  *)
    log "this setup needs apt + systemd!"
    log "detected os: $(uname -s)"
    exit 1
    ;;
esac

if [ ! -f /etc/os-release ]; then
  log "can't detect distro (/etc/os-release missing)!"
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "debian" ] && [ "${ID:-}" != "ubuntu" ] && [[ "${ID_LIKE:-}" != *debian* ]]; then
  log "unsupported distro for this setup: ${PRETTY_NAME:-unknown}!"
  exit 1
fi

require_cmd apt-get
require_cmd systemctl

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  sudo() { "$@"; }
elif ! command -v sudo >/dev/null 2>&1; then
  log "sudo is required when not root!"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export DEBIAN_FRONTEND=noninteractive

log "stopping all running services..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 stop ask 2>/dev/null || true
    pm2 stop waves 2>/dev/null || true
    pm2 stop mochi 2>/dev/null || true
    pm2 stop cloudsync 2>/dev/null || true
    pm2 stop nuru 2>/dev/null || true
    pm2 delete ask 2>/dev/null || true
    pm2 delete waves 2>/dev/null || true
    pm2 delete mochi 2>/dev/null || true
    pm2 delete cloudsync 2>/dev/null || true
    pm2 delete nuru 2>/dev/null || true
fi
for svc in nuru nuru-route.timer nuru-route wg-quick@wg0 caddy anubis eturnal; do
    sudo systemctl stop "$svc" 2>/dev/null || true
    sudo systemctl disable "$svc" 2>/dev/null || true
done
if command -v docker >/dev/null 2>&1; then
    sudo docker stop anubis 2>/dev/null || true
    sudo docker rm anubis 2>/dev/null || true
fi
if command -v wg-quick >/dev/null 2>&1; then
    sudo wg-quick down wg0 2>/dev/null || true
fi
if command -v ip >/dev/null 2>&1; then
    sudo ip link delete veth0-global 2>/dev/null || true
    sudo ip link delete wg0 2>/dev/null || true
fi
pkill -f nuru-route.sh 2>/dev/null || true
log "all services stopped!"

log "the setup process is about to start, if you have any issues join discord.gg/dJvdkPRheV for support!"
if [ "$AUTO_YES" -eq 1 ]; then
  log "non-interactive mode enabled, starting setup..."
elif [ ! -t 0 ]; then
  log "stdin is not interactive. re-run with --yes for unattended setup!"
  exit 1
else
  log "type 'ok' to continue or 'cancel' to abort!"
  while true; do
    read -r -p "> " user_input
    case "$user_input" in
      ok)
        log "starting setup..."
        break
        ;;
      cancel)
        log "setup aborted!"
        exit 0
        ;;
      *)
        log "please type 'ok' or 'cancel'!"
        ;;
    esac
  done
fi

WG_ENABLED=0
WG_REUSE=0

if sudo [ -f /etc/wireguard/wg0.conf ]; then
    WG_ENABLED=1
    WG_REUSE=1
    log "detected existing wireguard config!"
fi

if [ "$AUTO_YES" -eq 0 ] && [ -t 0 ]; then
    if [ "$WG_REUSE" -eq 1 ]; then
        log "type 'k' to keep existing config or 'r' to replace it!"
        while true; do
            read -r -p "> " keep_choice
            case "$keep_choice" in
                k|keep)
                    break
                    ;;
                r|replace)
                    WG_REUSE=0
                    break
                    ;;
                *)
                    log "please type 'k' or 'r'"
                    ;;
            esac
        done
    else
        log "route nuru through wireguard vpn?"
        log "(helps avoid ip blocks)"
        log "type 'y' to configure or 'n' to skip!"
        while true; do
            read -r -p "> " ws_choice
            case "$ws_choice" in
                yes|y)
                    WG_ENABLED=1
                    break
                    ;;
                no|n)
                    WG_ENABLED=0
                    break
                    ;;
                *)
                    log "please type 'y' or 'n'"
                    ;;
            esac
        done
    fi

    if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
        while true; do
            WG_CONFIG_FILE="/tmp/wg0-config-paste"
            cat > "$WG_CONFIG_FILE" <<'WGEOF'
# paste your wireguard config below then save and exit!
#
# example:
# [Interface]
# PrivateKey = ...
# Address = ...
# DNS = ...
#
# [Peer]
# PublicKey = ...
# AllowedIPs = ...
# Endpoint = ...
# PresharedKey = ...
WGEOF
            nano "$WG_CONFIG_FILE" </dev/tty >/dev/tty 2>&1 || true
            if [ ! -s "$WG_CONFIG_FILE" ]; then
                log "empty config!"
                log "type 'r' to retry or 'c' to cancel vpn setup"
                read -r -p "> " retry
                case "$retry" in
                    r|retry) continue ;;
                    *) WG_ENABLED=0; break ;;
                esac
            elif ! grep -q '\[Interface\]' "$WG_CONFIG_FILE" 2>/dev/null; then
                log "invalid config (missing [Interface] section)!"
                log "type 'r' to retry or 'c' to cancel vpn setup"
                read -r -p "> " retry
                case "$retry" in
                    r|retry) continue ;;
                    *) WG_ENABLED=0; break ;;
                esac
            else
                log "wireguard config looks valid!"
                break
            fi
        done
    fi
fi

if [ "$WG_ENABLED" -eq 0 ]; then
    sudo systemctl stop nuru 2>/dev/null || true
    sudo systemctl disable nuru 2>/dev/null || true
    sudo systemctl stop nuru-route.timer 2>/dev/null || true
    sudo systemctl disable nuru-route.timer 2>/dev/null || true
    sudo systemctl stop wg-quick@wg0 2>/dev/null || true
    sudo systemctl disable wg-quick@wg0 2>/dev/null || true
    sudo wg-quick down wg0 2>/dev/null || true
fi

if command -v ip >/dev/null 2>&1; then
    sudo ip link delete veth0-global 2>/dev/null || true
fi
if command -v modprobe >/dev/null 2>&1; then
    sudo modprobe nf_conntrack || true
fi
retry 3 sudo apt-get update -y
retry 3 sudo apt-get install -y --no-install-recommends unzip libcap2-bin jq dnsutils build-essential pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https docker.io libjemalloc2 ca-certificates curl gnupg lsb-release openssl

if [ "$WG_ENABLED" -eq 1 ]; then
    if ! command -v wg-quick >/dev/null 2>&1; then
        log "installing wireguard-tools..."
        retry 3 sudo apt-get install -y --no-install-recommends wireguard-tools || {
            log "wireguard-tools installation failed! skipping vpn setup..."
            WG_ENABLED=0
        }
    fi
    if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
        log "installing wireguard config..."
        sed -i '/^[[:space:]]*#/d' "$WG_CONFIG_FILE"
        sed -i -E 's/[0-9a-f]*:[0-9a-f:.]+\/[0-9]+//g' "$WG_CONFIG_FILE"
        sed -i -E 's/,\s*,/, /g' "$WG_CONFIG_FILE"
        sed -i -E 's/=\s*,/ = /g' "$WG_CONFIG_FILE"
        sed -i -E 's/,\s*$//' "$WG_CONFIG_FILE"
        PHYS_DEV=$(ip -4 route show default 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -1)
        if [ -n "$PHYS_DEV" ]; then
            PHYS_MTU=$(ip link show "$PHYS_DEV" 2>/dev/null | sed -n 's/.*mtu \([0-9]*\).*/\1/p')
        fi
        WG_MTU=$(( ${PHYS_MTU:-1500} - 80 ))
        [ "$WG_MTU" -lt 1280 ] && WG_MTU=1280
        sed -i '/^\[Interface\]/a Table = off' "$WG_CONFIG_FILE"
        sed -i "/^\[Interface\]/a MTU = $WG_MTU" "$WG_CONFIG_FILE"
        sed -i '/^\[Interface\]/a PostUp = wg set %i fwmark 0xca6c' "$WG_CONFIG_FILE"
        sudo mkdir -p /etc/wireguard
        sudo cp "$WG_CONFIG_FILE" /etc/wireguard/wg0.conf
        sudo chmod 600 /etc/wireguard/wg0.conf
        rm -f "$WG_CONFIG_FILE"
        log "wireguard config installed at /etc/wireguard/wg0.conf (MTU: $WG_MTU, fwmark: 0xca6c)!"
    fi
    if [ "$WG_ENABLED" -eq 1 ]; then
        sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
        [ "$WG_REUSE" -eq 1 ] && log "reusing existing wireguard config at /etc/wireguard/wg0.conf"
    fi
fi

if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  curl -fsS -o /tmp/eturnal-install.sh https://eturnal.net/install
  sudo sh /tmp/eturnal-install.sh
  rm -f /tmp/eturnal-install.sh
fi
if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  log "eturnal installation failed!"
  exit 1
fi
export PATH="/opt/eturnal/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  log "bun installation failed!"
  exit 1
fi
require_cmd bun

BUN_BIN="$(command -v bun)"

if ! "$BUN_BIN" pm -g ls | grep -q "pm2@"; then
  "$BUN_BIN" add -g pm2
else
  "$BUN_BIN" update -g pm2
fi

PM2_BIN="$(command -v pm2 || true)"
if [ -z "$PM2_BIN" ] && [ -x "$HOME/.bun/bin/pm2" ]; then
  PM2_BIN="$HOME/.bun/bin/pm2"
fi
if [ -z "$PM2_BIN" ]; then
  log "pm2 installation failed!"
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1; then
  log "cargo installation failed!"
  exit 1
fi
require_cmd cargo

CARGO_BIN="$(command -v cargo)"

if ! dpkg-query -W -f='${Status}' caddy 2>/dev/null | grep -q "install ok installed"; then
  sudo mkdir -p /usr/share/keyrings /etc/apt/sources.list.d
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  retry 3 sudo apt-get update -y
  retry 3 sudo apt-get install -y --no-install-recommends caddy
fi

if [ -f /etc/sysctl.d/99-waves-optimizations.conf ]; then
  sudo cp /etc/sysctl.d/99-waves-optimizations.conf /etc/sysctl.d/99-waves-optimizations.conf.bak.$(date +%s)
fi

cat <<EOF | sudo tee /etc/sysctl.d/99-waves-optimizations.conf
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.ip_local_port_range = 1024 65535
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 0
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192
fs.file-max = 2097152
fs.nr_open = 2097152
vm.swappiness = 10
vm.vfs_cache_pressure = 50
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_fin_timeout = 10
net.core.optmem_max = 25165824
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.send_redirects = 0
EOF
sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf || true

if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
  echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi
if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
  echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi

if [ -d "nuru" ]; then
    cd nuru
  RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
    sudo cp target/release/nuru /usr/local/bin/nuru
  sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true
    cd ..
else
    log "nuru directory not found!"
    exit 1
fi

if [ "$WG_ENABLED" -eq 1 ]; then
    id -u nuru >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin nuru
    sudo chown nuru:nuru /usr/local/bin/nuru
    sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true

    cat <<'NRSCRIPT' | sudo tee /usr/local/bin/nuru-route.sh > /dev/null
#!/bin/bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "[nuru-route] must run as root!" >&2
    exit 0
fi

log() { echo "[nuru-route] $(date '+%H:%M:%S') $*"; }

NURU_UID=$(id -u nuru 2>/dev/null || echo "")
[ -z "$NURU_UID" ] && { log "nuru user not found!"; exit 0; }

WG_IFACES=()
if command -v wg >/dev/null 2>&1; then
    while IFS= read -r line; do
        WG_IFACES+=("$line")
    done < <(wg show interfaces 2>/dev/null || true)
fi

if [ ${#WG_IFACES[@]} -eq 0 ]; then
    for iface in utun420 tun0 tun1 wg0; do
        if ip link show "$iface" &>/dev/null 2>&1; then
            if ! command -v wg >/dev/null 2>&1 || wg show "$iface" >/dev/null 2>&1; then
                WG_IFACES+=("$iface")
            fi
        fi
    done
fi

log "detected wireguard interfaces: ${WG_IFACES[*]:-none}"

MAIN_DEF=""
while read -r route; do
    if ! echo "$route" | grep -qE 'dev (utun|tun|wg)'; then
        MAIN_DEF="$route"
        break
    fi
done < <(ip route show default 2>/dev/null || true)

if [ -z "$MAIN_DEF" ]; then
    PHYS_IF=$(ip -br link show 2>/dev/null | grep -vE '^(lo|utun|tun|wg|veth|docker|br-)' | awk 'NR==1 {print $1}')
    if [ -n "$PHYS_IF" ]; then
        PHYS_GW=$(ip route show 0/0 dev "$PHYS_IF" 2>/dev/null | awk '{print $3}' || true)
        if [ -z "$PHYS_GW" ]; then
            PHYS_IP=$(ip -4 addr show "$PHYS_IF" 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
            if [ -n "$PHYS_IP" ]; then
                PHYS_GW=$(echo "$PHYS_IP" | awk -F. '{print $1"."$2"."$3".1"}')
            fi
        fi
        [ -n "$PHYS_GW" ] && MAIN_DEF="default via $PHYS_GW dev $PHYS_IF"
    fi
fi
[ -z "$MAIN_DEF" ] && { log "cannot determine physical default route!"; exit 0; }

ip rule del fwmark 0xca6c/0xca6c lookup main 2>/dev/null || true
ip rule del uidrange "$NURU_UID"-"$NURU_UID" lookup 200 2>/dev/null || true
ip route flush table 200 2>/dev/null || true
while read -r route; do
    ip route del $route 2>/dev/null || true
done < <(ip route show default 2>/dev/null | grep -E "dev (utun|tun|wg)" || true)
ip route replace $MAIN_DEF 2>/dev/null || true

log "main table default: $MAIN_DEF"

ip rule add fwmark 0xca6c/0xca6c lookup main priority 500 2>/dev/null || true
ip rule add uidrange "$NURU_UID"-"$NURU_UID" lookup 200 priority 1000 2>/dev/null || true

if [ ${#WG_IFACES[@]} -gt 0 ]; then
    VPN_IF="${WG_IFACES[0]}"
    log "routing nuru through $VPN_IF"

    VPN_DEF=$(ip route show default dev "$VPN_IF" 2>/dev/null | head -1 || true)
    if [ -n "$VPN_DEF" ]; then
        ip route add $VPN_DEF table 200 2>/dev/null || true
    else
        ip route add default dev "$VPN_IF" table 200 2>/dev/null || true
    fi

    ip route show dev "$VPN_IF" 2>/dev/null | while read -r route; do
        [ -n "$route" ] && ip route add $route table 200 2>/dev/null || true
    done

    log "table 200 configured via $VPN_IF"
else
    log "no vpn: nuru using physical ip"
    ip route add $MAIN_DEF table 200 2>/dev/null || true
fi

log "--- policy routing rules ---"
ip rule list 2>/dev/null | head -10 || true
exit 0
NRSCRIPT
    sudo chmod 755 /usr/local/bin/nuru-route.sh

    if [ -f /etc/wireguard/wg0.conf ]; then
        log "bringing up wg0..."
        sudo wg-quick up wg0 2>&1 || true
        sleep 2
        sudo /usr/local/bin/nuru-route.sh || true
    fi

    JEMALLOC_PATH=""
    if [ -f /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 ]; then
        JEMALLOC_PATH="/usr/lib/x86_64-linux-gnu/libjemalloc.so.2"
    elif [ -f /usr/lib/aarch64-linux-gnu/libjemalloc.so.2 ]; then
        JEMALLOC_PATH="/usr/lib/aarch64-linux-gnu/libjemalloc.so.2"
    fi

    cat <<NURUSVC | sudo tee /etc/systemd/system/nuru.service > /dev/null
[Unit]
Description=nuru proxy
After=network-online.target nss-lookup.target wg-quick@wg0.service
Wants=network-online.target wg-quick@wg0.service

[Service]
User=nuru
Type=simple
ExecStartPre=!-/usr/local/bin/nuru-route.sh
ExecStart=/usr/local/bin/nuru /etc/nuru/config.toml
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=10
Environment=RUST_LOG=off
NURUSVC
    if [ -n "$JEMALLOC_PATH" ]; then
        echo "Environment=LD_PRELOAD=$JEMALLOC_PATH" | sudo tee -a /etc/systemd/system/nuru.service > /dev/null
    fi
    cat <<NURUSVC2 | sudo tee -a /etc/systemd/system/nuru.service > /dev/null
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
NURUSVC2

    cat <<NRROUTE | sudo tee /etc/systemd/system/nuru-route.service > /dev/null
[Unit]
Description=setup nuru vpn routing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/nuru-route.sh
NRROUTE

    cat <<NRTIMER | sudo tee /etc/systemd/system/nuru-route.timer > /dev/null
[Unit]
Description=nuru vpn routing check

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
NRTIMER

    sudo systemctl daemon-reload
    sudo systemctl enable nuru-route.timer >/dev/null 2>&1 || true
    sudo systemctl start nuru-route.timer 2>/dev/null || true
    sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
fi

PUBLIC_IP="$(curl -s4 --max-time 8 ifconfig.me || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(dig +short txt ch whoami.cloudflare @1.0.0.1 2>/dev/null | tr -d '"' || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}' || true)"

if [ -z "$PUBLIC_IP" ]; then
  log "couldn't detect public ip!"
  exit 1
fi

if [ -f /etc/eturnal.yml ]; then
  sudo cp /etc/eturnal.yml /etc/eturnal.yml.bak.$(date +%s)
fi

sudo tee /etc/eturnal.yml <<EOF
eturnal:
  credentials:
    enniuu: enni
  realm: waves.lat
  relay_ipv4_addr: "$PUBLIC_IP"
  listen:
    - ip: "0.0.0.0"
      port: 3478
      transport: udp
    - ip: "0.0.0.0"
      port: 3478
      transport: tcp
  relay_min_port: 49152
  relay_max_port: 65535
  log_dir: stdout
  log_level: warning
  modules:
    mod_log_stun: {}
EOF
if [ -f /etc/eturnal.yml ]; then
  log "/etc/eturnal.yml applied!"
else
  log "error: /etc/eturnal.yml not found!"
  exit 1
fi

sudo chown eturnal:eturnal /etc/eturnal.yml
sudo chmod 640 /etc/eturnal.yml
sudo systemctl stop coturn 2>/dev/null || true
sudo systemctl disable coturn 2>/dev/null || true
sudo fuser -k 3478/tcp 2>/dev/null || true
sudo fuser -k 3478/udp 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable eturnal
sudo systemctl restart eturnal

if ! systemctl is-active --quiet eturnal; then
  log "error: eturnal failed to start!"
  sudo journalctl -u eturnal --no-pager -n 20 >&2
  exit 1
fi

sudo systemctl enable docker >/dev/null 2>&1 || true
sudo systemctl start docker >/dev/null 2>&1 || true
if ! sudo docker info >/dev/null 2>&1; then
  log "docker daemon is not ready!"
  exit 1
fi
require_cmd docker
require_cmd caddy

export PATH="$HOME/.bun/bin:$PATH"
export IP="$PUBLIC_IP"

if [ -f bun.lock ] || [ -f bun.lockb ]; then
  "$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
else
  "$BUN_BIN" install
fi

if [ -d "mochi" ]; then
    cd mochi
  RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
    cd ..
fi

if [ -d "cloudsync" ]; then
    cd cloudsync
  RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
    cd ..
fi

retry 3 sudo docker pull "ghcr.io/techarohq/anubis:latest"

if sudo docker ps -a | grep -q "anubis"; then
    sudo docker stop anubis 2>/dev/null || true
    sudo docker rm anubis 2>/dev/null || true
fi

cat <<'EOF' | sudo tee /etc/anubis-policy.yaml
bots:
  - import: (data)/meta/default-config.yaml
EOF
if [ -f /etc/anubis-policy.yaml ]; then
  log "/etc/anubis-policy.yaml applied!"
else
  log "error: /etc/anubis-policy.yaml not found!"
  exit 1
fi

sudo docker run -d --name anubis \
    --network="host" \
    --restart unless-stopped \
    -e TARGET="http://127.0.0.1:3000" \
    -e OG_PASSTHROUGH="true" \
    -e POLICY_FNAME=/botPolicies.yaml \
    -v /etc/anubis-policy.yaml:/botPolicies.yaml \
    "ghcr.io/techarohq/anubis:latest"

"$BUN_BIN" --bun run build

sudo mkdir -p /etc/nuru /etc/systemd/system/caddy.service.d

if [ -f /etc/systemd/system/caddy.service.d/override.conf ]; then
  sudo cp /etc/systemd/system/caddy.service.d/override.conf /etc/systemd/system/caddy.service.d/override.conf.bak.$(date +%s)
  log "backed up existing caddy override config!"
fi

sudo tee /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment="NO_PROXY=127.0.0.1"
EOF
sudo systemctl daemon-reload

if [ -f /etc/caddy/Caddyfile ]; then
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)
  log "backed up existing caddy config!"
fi

sudo tee /etc/caddy/Caddyfile <<EOF
{
    email sefiicc@gmail.com
    
    servers {
        protocols h1 h2 h3
    }

    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}

:443 {
    tls {
        on_demand
    }

    encode zstd gzip

    @nuru_routes {
        path /w/*
    }
    reverse_proxy @nuru_routes 127.0.0.1:8080 {
        lb_policy least_conn
        fail_duration 10s
        max_fails 4
        header_up Host {upstream_hostport}
        header_up X-Real-IP {remote_host}
        flush_interval -1
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            read_buffer 65536
            write_buffer 65536
        }
    }

    @mochi_routes {
        path /!!/* /!cover!/*
    }
    reverse_proxy @mochi_routes 127.0.0.1:4000 {
        lb_policy least_conn
        fail_duration 10s
        max_fails 4
        header_up Host {upstream_hostport}
        header_up X-Real-IP {remote_host}
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 60s
        }
    }

    handle /api/auth/* {
        reverse_proxy 127.0.0.1:5000 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /api/sync/* {
        reverse_proxy 127.0.0.1:5000 {
            header_up X-Real-IP {remote_host}
        }
    }

    reverse_proxy 127.0.0.1:8923 {
        header_up X-Real-IP {remote_host}
        transport http {
            keepalive 120s
            keepalive_idle_conns 512
            keepalive_idle_conns_per_host 64
            dial_timeout 5s
        }
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF
if [ -f /etc/caddy/Caddyfile ]; then
  log "/etc/caddy/Caddyfile applied!"
else
  log "error: /etc/caddy/Caddyfile not found!"
  exit 1
fi

if [ ! -f "$ROOT/nuru/config.toml" ]; then
    log "nuru config not found at $ROOT/nuru/config.toml !"
    exit 1
fi
if [ "$WG_ENABLED" -eq 1 ] && [ -f /etc/wireguard/wg0.conf ]; then
    VPN_DNS_LIST=$(grep -i '^DNS\s*=' /etc/wireguard/wg0.conf 2>/dev/null | sed 's/^DNS\s*=\s*//' | tr -d ' ' | tr ',' '\n' | grep -v '^$' || true)
    if [ -n "$VPN_DNS_LIST" ]; then
        DNS_TOML="["
        first=true
        while IFS= read -r dns; do
            if [ -n "$dns" ]; then
                [ "$first" = false ] && DNS_TOML+=", "
                DNS_TOML+="\"$dns\""
                first=false
            fi
        done <<< "$VPN_DNS_LIST"
        DNS_TOML+="]"
        sed -i "s|^dns_servers = \[.*\]|dns_servers = $DNS_TOML|" "$ROOT/nuru/config.toml"
        log "updated nuru DNS to use VPN DNS: $DNS_TOML"
    fi
fi
sudo cp "$ROOT/nuru/config.toml" /etc/nuru/config.toml
if [ -f /etc/nuru/config.toml ]; then
  log "/etc/nuru/config.toml applied!"
  if [ "$WG_ENABLED" -eq 1 ]; then
      sudo chown -R nuru:nuru /etc/nuru
  fi
else
  log "error: /etc/nuru/config.toml not found!"
  exit 1
fi

TOTAL_RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || free -m | awk '/^Mem:/ {print $2}' 2>/dev/null || 8192)
[ -z "$TOTAL_RAM_MB" ] || [ "$TOTAL_RAM_MB" -le 0 ] && TOTAL_RAM_MB=8192

calc_mem() {
  local pct=$1 min=$2 max=$3
  local val=$(( TOTAL_RAM_MB * pct / 100 ))
  [ "$val" -lt "$min" ] && val=$min
  [ "$val" -gt "$max" ] && val=$max
  echo "$val"
}

WAVES_MEM="$(calc_mem 16 256 2560)M"
MOCHI_MEM="$(calc_mem 24 384 5120)M"
CLOUDSYNC_MEM="$(calc_mem 6 128 768)M"
NURU_MEM="$(calc_mem 22 512 4608)M"
log "memory limits — waves: $WAVES_MEM, mochi: $MOCHI_MEM, cloudsync: $CLOUDSYNC_MEM, nuru: $NURU_MEM"

"$PM2_BIN" stop all >/dev/null 2>&1 || true
"$PM2_BIN" delete all >/dev/null 2>&1 || true

tee ecosystem.config.cjs <<EOF
module.exports = {
  apps: [
    {
      name: "ask",
      script: "$BUN_BIN",
      args: "run ask.js",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      max_memory_restart: "256M"
    },
    {
      name: "waves",
      script: "$BUN_BIN",
      args: "start",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      min_uptime: 15000,
      kill_timeout: 10000,
      max_memory_restart: "$WAVES_MEM",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        UV_THREADPOOL_SIZE: "32"
      }
    },
    {
      name: "mochi",
      script: "./mochi/target/release/mochi", 
      interpreter: "none", 
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      max_memory_restart: "$MOCHI_MEM",
      env: {
        RUST_LOG: "warn",
        MOCHI_PORT: "4000"
      }
    },
    {
      name: "cloudsync",
      script: "./target/release/cloudsync", 
      cwd: "./cloudsync",
      interpreter: "none", 
      exec_mode: "fork",
      instances: 1, 
      autorestart: true,
      max_memory_restart: "$CLOUDSYNC_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        RUST_LOG: "warn",
        CLOUDSYNC_DB_PATH: "$ROOT/cloudsync/.db"
      }
    },
EOF
if [ "$WG_ENABLED" -eq 0 ]; then
    tee -a ecosystem.config.cjs <<EOF
    {
      name: "nuru",
      script: "/usr/local/bin/nuru", 
      args: ["/etc/nuru/config.toml"], 
      interpreter: "none", 
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "$NURU_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        RUST_LOG: "off",
        LD_PRELOAD: "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2"
      }
    },
EOF
fi
tee -a ecosystem.config.cjs <<'EOF'
  ]
};
EOF

sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 443/udp
    sudo ufw allow 3478/tcp
    sudo ufw allow 3478/udp
    sudo ufw allow 49152:65535/udp
fi


if [ ! -f .env ]; then
    JWT_SECRET=$(openssl rand -hex 64)
    SYNC_SECRET=$(openssl rand -hex 32)
    echo "JWT_SECRET=$JWT_SECRET" > .env
    echo "SYNC_SECRET=$SYNC_SECRET" >> .env
    chmod 600 .env
else
    if ! grep -q "JWT_SECRET" .env; then
        JWT_SECRET=$(openssl rand -hex 64)
        echo "" >> .env
        echo "JWT_SECRET=$JWT_SECRET" >> .env
    else
        JWT_SECRET=$(grep "^JWT_SECRET=" .env | cut -d '=' -f2)
    fi

    if ! grep -q "SYNC_SECRET" .env; then
        SYNC_SECRET=$(openssl rand -hex 32)
        echo "SYNC_SECRET=$SYNC_SECRET" >> .env
    else
        SYNC_SECRET=$(grep "^SYNC_SECRET=" .env | cut -d '=' -f2)
    fi
fi

if [ -d "cloudsync" ]; then
    echo "JWT_SECRET=$JWT_SECRET" > cloudsync/.env
    echo "SYNC_SECRET=$SYNC_SECRET" >> cloudsync/.env
    echo "COOKIE_SECURE=true" >> cloudsync/.env
    chmod 600 cloudsync/.env
    if [ -f cloudsync/.env ]; then
      log "cloudsync/.env applied!"
    else
      log "error: cloudsync/.env not found!"
      exit 1
    fi
fi

if [ ! -f "cloudsync/.db" ]; then
    touch cloudsync/.db
fi

if [ -f "cloudsync/.db" ]; then
    chmod 600 cloudsync/.db
  chmod 600 cloudsync/.db-shm 2>/dev/null || true
  chmod 600 cloudsync/.db-wal 2>/dev/null || true
fi

"$PM2_BIN" start ecosystem.config.cjs --update-env
"$PM2_BIN" save
sudo env PATH="$PATH:$HOME/.bun/bin" "$PM2_BIN" startup systemd -u "$USER" --hp "$HOME" || true

if [ "$WG_ENABLED" -eq 1 ]; then
    log "starting nuru systemd service..."
    sudo systemctl daemon-reload
    sudo systemctl enable nuru >/dev/null 2>&1 || true
    sudo systemctl restart nuru 2>/dev/null || true
    sleep 2
    if systemctl is-active --quiet nuru; then
        log "nuru systemd service running!"
    else
        log "warning: nuru systemd service failed to start!"
        sudo journalctl -u nuru --no-pager -n 10 >&2
    fi
fi

if [ "$WG_ENABLED" -eq 0 ]; then
    PM2_SVCS="ask|waves|mochi|cloudsync|nuru"
else
    PM2_SVCS="ask|waves|mochi|cloudsync"
fi
if ! "$PM2_BIN" list | grep -Eq "$PM2_SVCS"; then
  log "pm2 processes did not start correctly!"
  exit 1
fi

log "all done! your waves instance is now all setup and ready to be used!!!!"