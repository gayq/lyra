#!/bin/bash

echo "if you have any issues join discord.gg/dJvdkPRheV for support!"
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

sudo apt-get update -y
sudo apt-get install -y unzip curl jq dnsutils build-essential pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https

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

cd "$HOME/waves"
export PATH="$HOME/.bun/bin:$PATH"

if [ -d "mochi" ]; then
    cd mochi
    RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
    cd ..
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

    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}

:443 {
    tls {
        on_demand
    }

    encode zstd gzip

    reverse_proxy /!!/* 127.0.0.1:4000 {
        header_up X-Real-IP {remote_host}
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 60s
        }
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF

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

"$HOME/.bun/bin/pm2" start ecosystem.config.cjs --update-env
"$HOME/.bun/bin/pm2" save
sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"

echo "mochi is all set up!!"