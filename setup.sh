#!/bin/bash

echo "the setup proccess is about to start, if you have any issues join discord.gg/dJvdkPRheV for support!"
echo ""
echo "type 'ok' to continue or 'cancel' to abort."

while true; do
    read -p "> " user_input
    case "$user_input" in
        ok)
            echo "starting setup..."
            break
            ;;
        cancel)
            echo "setup aborted."
            exit 0
            ;;
        *)
            echo "please type 'ok' or 'cancel'."
            ;;
    esac
done

read -p "enter the domain for this node: " DOMAIN

if [ -z "$DOMAIN" ]; then
    echo "domain cannot be empty. aborting."
    exit 1
fi

sudo apt-get update -y
sudo apt-get install -y unzip libcap2-bin jq dnsutils build-essential pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https libjemalloc2

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

if ! command -v node; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! dpkg-query -l | grep -q caddy; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

cat <<EOF | sudo tee /etc/sysctl.d/99-waves-optimizations.conf
net.netfilter.nf_conntrack_max = 524288
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
git fetch && git checkout . && git pull
if ! grep -q "^\[profile.release\]" Cargo.toml; then
    printf "\n[profile.release]\nlto = \"fat\"\ncodegen-units = 1\npanic = \"abort\"\nstrip = true\nopt-level = 3\n" >> Cargo.toml
fi
RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
sudo cp target/release/epoxy-server /usr/local/bin/epoxy-server
sudo setcap cap_net_bind_service=+ep /usr/local/bin/epoxy-server

sudo mkdir -p /etc/epoxy-server
sudo tee /etc/epoxy-server/config.toml <<EOF
[server]
bind = ["tcp", "0.0.0.0:8080"]
transport = "websocket"
resolve_ipv6 = false
tcp_nodelay = true
file_raw_mode = false
use_real_ip_headers = true
non_ws_response = "hii! You should join discord.gg/dJvdkPRheV :3"
max_message_size = 1048576
log_level = "OFF"
runtime = "multithread"
stats_endpoint = "/stats"
[wisp]
allow_wsproxy = true
buffer_size = 65536
prefix = "/w"
wisp_v2 = true
extensions = ["udp", "motd"]
password_extension_required = false
certificate_extension_required = false
[stream]
tcp_nodelay = true
buffer_size = 524288
allow_udp = true
allow_wsproxy_udp = false
dns_servers = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"]
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

cd "$HOME/waves" || { echo "Run this in the waves directory!"; exit 1; }
export PATH="$HOME/.bun/bin:$PATH"

if [ -d "mochi" ]; then
    cd mochi
    RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
    cd ..
else
    echo "Could not find mochi directory! Did you clone the complete waves repository?"
    exit 1
fi

sudo mkdir -p /etc/systemd/system/caddy.service.d

sudo tee /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment="NO_PROXY=127.0.0.1"
EOF
sudo systemctl daemon-reload

sudo tee /etc/caddy/Caddyfile <<EOF
{
    email sefiicc@gmail.com
    
    servers {
        protocols h1 h2 h3
    }
}

$DOMAIN {
    encode zstd gzip

    reverse_proxy /w/* 127.0.0.1:8080 {
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
        header_up X-Real-IP {remote_host}
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 60s
        }
    }

    handle / {
        respond "<html><body style=\"background-color: black; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: monospace; font-size: 24px;\">discord.gg/dJvdkPRheV</body></html>" 200 {
            close
        }
        header Content-Type "text/html; charset=utf-8"
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF

"$HOME/.bun/bin/pm2" stop all
"$HOME/.bun/bin/pm2" delete all

tee ecosystem_mochi.config.cjs <<EOF
module.exports = {
  apps: [
    {
      name: "mochi",
      script: "./mochi/target/release/mochi", 
      interpreter: "none", 
      exec_mode: "fork",
      instances: 1, 
      autorestart: true,
      max_memory_restart: "8G", 
      env: {
        RUST_LOG: "info",
        MOCHI_PORT: "4000"
      }
    },
    {
      name: "epoxy-server",
      script: "/usr/local/bin/epoxy-server", 
      args: ["/etc/epoxy-server/config.toml"], 
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "8G",
      env: {
        RUST_LOG: "off",
        LD_PRELOAD: "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2"
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
fi

"$HOME/.bun/bin/pm2" start ecosystem_mochi.config.cjs --update-env
"$HOME/.bun/bin/pm2" save
sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"

echo "all done! your waves node is now ready to be used!!!!"