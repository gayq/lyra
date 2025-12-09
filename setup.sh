#!/bin/bash

echo "The setup proccess is about to start, if you have any issues join discord.gg/dJvdkPRheV for support."
echo ""
echo "Type 'ok' to continue or 'cancel' to abort."

while true; do
    read -p "> " user_input
    case $user_input in
        ok)
            echo "Starting setup..."
            break
            ;;
        cancel)
            echo "Setup aborted."
            exit 0
            ;;
        *)
            echo "Please type 'ok' or 'cancel'."
            ;;
    esac
done

sudo apt-get update -y
sudo apt-get install -y unzip libcap2-bin jq dnsutils coturn proxychains4 build-essential pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https

if ! command -v bun; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! $HOME/.bun/bin/bun pm -g ls | grep -q "pm2@"; then
  $HOME/.bun/bin/bun add -g pm2
else
  $HOME/.bun/bin/bun update -g pm2
fi

if ! command -v cargo; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! dpkg-query -l | grep -q caddy; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

if ! command -v node; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

WGCF_URL=$(curl -s https://api.github.com/repos/ViRb3/wgcf/releases/latest | jq -r '.assets[] | select(.name | endswith("_linux_amd64")) | .browser_download_url')
WIREPROXY_URL=$(curl -s https://api.github.com/repos/whyvl/wireproxy/releases/latest | jq -r '.assets[] | select(.name | endswith("_linux_amd64.tar.gz")) | .browser_download_url')

curl -L -o wgcf "$WGCF_URL"
chmod +x wgcf
sudo mv wgcf /usr/local/bin/wgcf

curl -L -o wireproxy.tar.gz "$WIREPROXY_URL"
tar -xzf wireproxy.tar.gz
chmod +x wireproxy
sudo mv wireproxy /usr/local/bin/wireproxy
rm wireproxy.tar.gz
sudo setcap cap_net_admin+eip /usr/local/bin/wireproxy

sudo tee /etc/proxychains4.conf <<EOF
strict_chain
proxy_dns
remote_dns_subnet 224
tcp_read_time_out 15000
tcp_connect_time_out 8000
[ProxyList]
socks5 127.0.0.1 40000
EOF

if [ ! -f "/etc/wireproxy/wireproxy.conf" ]; then
    sudo mkdir -p /etc/wireproxy
    yes | wgcf register --accept-tos
    wgcf generate
    
    ENDPOINT=$(grep "Endpoint" wgcf-profile.conf | cut -d " " -f 3)
    HOST=$(echo $ENDPOINT | cut -d ":" -f 1)
    PORT=$(echo $ENDPOINT | cut -d ":" -f 2)
    
    IP=$(dig +short "$HOST" | head -n 1)
    [ -z "$IP" ] && IP=$(getent hosts "$HOST" | awk '{ print $1 }' | head -n 1)
    [ -z "$IP" ] && IP="162.159.192.1"
    
    grep -v -e "^DNS" -e "^MTU" wgcf-profile.conf | sudo tee /etc/wireproxy/wireproxy.conf
    sudo sed -i "s|$HOST:$PORT|$IP:$PORT|" /etc/wireproxy/wireproxy.conf
    
    cat <<WG_APPEND | sudo tee -a /etc/wireproxy/wireproxy.conf

[Socks5]
BindAddress = 127.0.0.1:40000

[HttpProxy]
BindAddress = 127.0.0.1:3128
WG_APPEND
    
    rm wgcf-profile.conf
fi

cat <<EOF | sudo tee /etc/sysctl.d/99-waves-optimizations.conf
net.netfilter.nf_conntrack_max = 2000000
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
net.ipv6.conf.lo.disable_ipv6 = 1
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192
fs.file-max = 2097152
fs.nr_open = 2097152
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf
if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
  echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi
if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
  echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi

if [ ! -d "$HOME/epoxy-tls" ]; then
    git clone https://github.com/MercuryWorkshop/epoxy-tls.git "$HOME/epoxy-tls"
fi
cd "$HOME/epoxy-tls"
git fetch && git checkout prod && git pull
if ! grep -q "^\[profile.release\]" Cargo.toml; then
    printf "\n[profile.release]\nlto = \"fat\"\ncodegen-units = 1\npanic = \"abort\"\nstrip = true\nopt-level = 3\n" >> Cargo.toml
fi
RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
sudo cp target/release/epoxy-server /usr/local/bin/epoxy-server
sudo setcap cap_net_bind_service=+ep /usr/local/bin/epoxy-server

PUBLIC_IP=$(curl -s4 ifconfig.me)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(dig +short txt ch whoami.cloudflare @1.0.0.1 | tr -d '"')

sudo tee /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
lt-cred-mech
user=luy:l4uy
realm=waves.lat
external-ip=$PUBLIC_IP
min-port=49152
max-port=65535
log-file=/var/log/turnserver.log
verbose
EOF
sudo systemctl enable coturn
sudo systemctl restart coturn

cd "$HOME/waves"
export PATH="$HOME/.bun/bin:$PATH"
export IP="$PUBLIC_IP"
bun install
bun run build

sudo mkdir -p /etc/epoxy-server /etc/systemd/system/caddy.service.d

sudo tee /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment="NO_PROXY=127.0.0.1"
EOF
sudo systemctl daemon-reload

sudo tee /etc/caddy/Caddyfile <<EOF
{
    email sefiicc@gmail.com
    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}
:443 {
    tls {
        on_demand
        issuer acme {
            email sefiicc@gmail.com
        }
        issuer zerossl {
            email sefiicc@gmail.com
        }
    }
    @websockets {
        path /w/*
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websockets http://localhost:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
    reverse_proxy /!!/* http://localhost:4000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
        flush_interval -1
        transport http {
            response_header_timeout 60s
            dial_timeout 10s
        }
    }
    reverse_proxy * http://localhost:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "ALLOWALL"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "no-referrer"
        Permissions-Policy "interest-cohort=(), payment=(), usb=(), geolocation=()"
    }
}
:80 {
    redir https://{host}{uri} permanent
}
EOF

sudo tee /etc/epoxy-server/config.toml <<EOF
[server]
bind = ["tcp", "0.0.0.0:8080"]
transport = "websocket"
resolve_ipv6 = false
tcp_nodelay = true
file_raw_mode = false
use_real_ip_headers = false
non_ws_response = "Hii! You should join discord.gg/dJvdkPRheV"
max_message_size = 65536
log_level = "INFO"
runtime = "multithread"
[wisp]
allow_wsproxy = true
buffer_size = 262144
prefix = "/w"
wisp_v2 = true
extensions = ["udp", "motd"]
password_extension_required = true
certificate_extension_required = true
[stream]
tcp_nodelay = true
buffer_size = 262144
allow_udp = true
allow_wsproxy_udp = false
dns_servers = ["1.1.1.1", "1.0.0.1", "94.140.14.14", "94.140.15.15"]
allow_direct_ip = true
allow_loopback = true
allow_multicast = true
allow_global = true
allow_non_global = true
allow_tcp_hosts = []
block_tcp_hosts = []
allow_udp_hosts = []
block_udp_hosts = []
allow_hosts = []
block_hosts = []
allow_ports = []
block_ports = []
EOF

tee ecosystem.config.cjs <<EOF
module.exports = {
  apps: [
    {
      name: "ask",
      script: "bun",
      args: "run ask.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "150M"
    },
    {
      name: "waves-ui",
      script: "./index.mjs",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      node_args: "--max-old-space-size=512 --turbo-fast-api-calls --no-warnings",
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    },
    {
      name: "waves-bridge",
      script: "./bridge-server.mjs",
      exec_mode: "fork",
      instances: "1",
      autorestart: true,
      max_memory_restart: "6G",
      exp_backoff_restart_delay: 100,
      node_args: "--max-old-space-size=6144 --turbo-fast-api-calls --no-warnings --max-http-header-size=32768",
      env: {
        NODE_ENV: "production",
        BRIDGE_PORT: "4000",
        UV_THREADPOOL_SIZE: "128",
        HTTP_PROXY: "http://127.0.0.1:3128"
      }
    },
    {
      name: "wireproxy",
      script: "/usr/local/bin/wireproxy",
      args: ["-c", "/etc/wireproxy/wireproxy.conf"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1500M"
    },
    {
      name: "epoxy-server",
      script: "proxychains4",
      args: ["/usr/local/bin/epoxy-server", "/etc/epoxy-server/config.toml"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "4G",
      env: {
        RUST_LOG: "info"
      }
    }
  ]
};
EOF

sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy

if command -v ufw && ufw status | grep -q "Status: active"; then
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 443/udp
    sudo ufw allow 3478/tcp
    sudo ufw allow 3478/udp
    sudo ufw allow 49152:65535/udp
fi

"$HOME/.bun/bin/pm2" start ecosystem.config.cjs --update-env
"$HOME/.bun/bin/pm2" save
sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"

echo "Done! Your Waves instance is now all setup and ready to be used!!!!"