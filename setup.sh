#!/bin/bash

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
            echo "setup aborted!"
            exit 0
            ;;
        *)
            echo "please type 'ok' or 'cancel'!"
            ;;
    esac
done

sudo ip link delete veth0-global 2>/dev/null
sudo modprobe nf_conntrack
sudo apt-get update -y
sudo apt-get install -y unzip libcap2-bin jq dnsutils build-essential pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https coturn docker.io libjemalloc2

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
net.ipv6.conf.lo.disable_ipv6 = 1
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
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
net.ipv4.tcp_fin_timeout = 15
EOF
sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf

if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
  echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi
if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
  echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi

if [ -d "nuru" ]; then
    cd nuru
    RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
    sudo cp target/release/nuru /usr/local/bin/nuru
    sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru
    cd ..
else
    echo "nuru directory not found!"
    exit 1
fi

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
no-stale-nonce
total-quota=0
log-file=/var/log/turnserver.log
EOF

if [ ! -f /etc/default/coturn ]; then
    echo "TURNSERVER_ENABLED=1" | sudo tee /etc/default/coturn
else
    sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn
fi

sudo systemctl unmask coturn
sudo systemctl enable coturn
sudo systemctl restart coturn

if ! systemctl is-active coturn; then
    sudo turnserver -c /etc/turnserver.conf -o -v -z &
fi

cd "$PROJECT_ROOT" || { echo "run this in the waves directory!"; exit 1; }
export PATH="$HOME/.bun/bin:$PATH"
export IP="$PUBLIC_IP"

bun install

if [ -d "mochi" ]; then
    cd mochi
    RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
    cd ..
fi

if [ -d "cloudsync" ]; then
    cd cloudsync
    RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
    cd ..
fi

sudo docker pull ghcr.io/techarohq/anubis:latest

if sudo docker ps -a | grep -q "anubis"; then
    sudo docker stop anubis 2>/dev/null || true
    sudo docker rm anubis 2>/dev/null || true
fi

cat <<'EOF' | sudo tee /etc/anubis-policy.yaml
bots:
  - name: pass-bunny-via
    headers_regex:
      Via: "(?i).*bunnycdn.*"
    action: ALLOW
  - name: pass-bunny-server
    headers_regex:
      Cdn-Serverid: ".*"
    action: ALLOW
  - name: pass-bunny-country
    headers_regex:
      Cdn-Requestcountrycode: ".*"
    action: ALLOW
  - name: pass-bunny-loop
    headers_regex:
      Cdn-Loop: "(?i).*bunnycdn.*"
    action: ALLOW
  - name: pass-b-cdn-xfh
    headers_regex:
      X-Forwarded-Host: "(?i).*\\.b-cdn\\.net.*"
    action: ALLOW
  - name: pass-b-cdn-referer
    headers_regex:
      Referer: "(?i).*\\.b-cdn\\.net.*"
    action: ALLOW
  - import: (data)/meta/default-config.yaml

thresholds:
  - name: allow-good-bots
    expression: weight < 0
    action: ALLOW
  - name: challenge-browsers
    expression: weight >= 0
    action: CHALLENGE
    challenge:
      algorithm: fast
      difficulty: 2
      report_as: 2
EOF

sudo docker run -d --name anubis \
    --network="host" \
    --restart unless-stopped \
    -e TARGET="http://127.0.0.1:3000" \
    -e OG_PASSTHROUGH="true" \
    -e POLICY_FNAME=/botPolicies.yaml \
    -v /etc/anubis-policy.yaml:/botPolicies.yaml \
    ghcr.io/techarohq/anubis:latest

bun run build

sudo mkdir -p /etc/nuru /etc/systemd/system/caddy.service.d

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

    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}

:80 {
    tls {
        on_demand
    }

    encode zstd gzip

    @nuru_routes {
        path /w/*
    }
    reverse_proxy @nuru_routes 127.0.0.1:8080 127.0.0.1:8081 127.0.0.1:8082 {
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
    reverse_proxy @mochi_routes 127.0.0.1:4000 127.0.0.1:4001 127.0.0.1:4002 {
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

http://127.0.0.1:4001 {
    reverse_proxy https://1.waves.lat {
        header_up Host 1.waves.lat
        transport http {
            tls_insecure_skip_verify
            tls_server_name 1.waves.lat
            versions 1.1
            keepalive 10s
            dial_timeout 5s
            response_header_timeout 60s
        }
    }
}

http://127.0.0.1:4002 {
    reverse_proxy https://2.waves.lat {
        header_up Host 2.waves.lat
        transport http {
            tls_insecure_skip_verify
            tls_server_name 2.waves.lat
            versions 1.1
            keepalive 10s
            dial_timeout 5s
            response_header_timeout 60s
        }
    }
}

http://127.0.0.1:8081 {
    reverse_proxy https://1.waves.lat {
        header_up Host 1.waves.lat
        transport http {
            tls_insecure_skip_verify
            tls_server_name 1.waves.lat
            versions 1.1
            keepalive 10s
            dial_timeout 5s
            response_header_timeout 60s
        }
    }
}

http://127.0.0.1:8082 {
    reverse_proxy https://2.waves.lat {
        header_up Host 2.waves.lat
        transport http {
            tls_insecure_skip_verify
            tls_server_name 2.waves.lat
            versions 1.1
            keepalive 10s
            dial_timeout 5s
            response_header_timeout 60s
        }
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF

if [ ! -f "$PROJECT_ROOT/nuru/config.toml" ]; then
    echo "nuru config not found at $PROJECT_ROOT/nuru/config.toml !"
    exit 1
fi
sudo cp "$PROJECT_ROOT/nuru/config.toml" /etc/nuru/config.toml

"$HOME/.bun/bin/pm2" stop all
"$HOME/.bun/bin/pm2" delete all

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
      max_memory_restart: "256M"
    },
    {
      name: "waves",
      script: "./index.mjs",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "4G",
      node_args: "--max-old-space-size=4096 --turbo-fast-api-calls --no-warnings",
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    },
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
      name: "cloudsync",
      script: "./target/release/cloudsync", 
      cwd: "./cloudsync",
      interpreter: "none", 
      exec_mode: "fork",
      instances: 1, 
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        RUST_LOG: "info"
      }
    },
    {
      name: "nuru",
      script: "/usr/local/bin/nuru", 
      args: ["/etc/nuru/config.toml"], 
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
    chmod 600 cloudsync/.env
fi

if [ ! -f "cloudsync/.db" ]; then
    touch cloudsync/.db
fi

if [ -f "cloudsync/.db" ]; then
    chmod 600 cloudsync/.db
    chmod 600 cloudsync/.db-shm 2>/dev/null
    chmod 600 cloudsync/.db-wal 2>/dev/null
fi

"$HOME/.bun/bin/pm2" start ecosystem.config.cjs --update-env
"$HOME/.bun/bin/pm2" save
sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"

echo "all done! your waves instance is now all setup and ready to be used!!!!"