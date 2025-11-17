#!/bin/bash

BLUE='\033[1;38;2;137;180;250m'
GREEN='\033[1;38;2;166;227;161m'
RED='\033[1;38;2;243;139;168m'
MAUVE='\033[1;38;2;203;166;247m'
TEXT='\033[0;38;2;205;214;244m'
SURFACE='\033[38;2;69;71;90m'
RESET='\033[0m'
CLEAR_LINE='\r\033[K'

info() {
  printf "\n${BLUE}❯${RESET}${TEXT} %s${RESET}\n" "$1"
}

success() {
  printf "  ${GREEN}✔${RESET}${TEXT} %s${RESET}\n" "$1"
}

error() {
  printf "${CLEAR_LINE}  ${RED}✖${RESET}${TEXT} %s${RESET}\n" "$1"
  if [ -n "$2" ]; then
    printf "    ${RED}|${RESET} ${TEXT}%s${RESET}\n" "$2"
  fi
  exit 1
}

warn() {
  printf "  ${RED}![IMPORTANT]${RESET}${TEXT} %s${RESET}\n" "$1"
}

run_task() {
    local msg=$1
    local success_msg=$2
    local cmd=$3
    local i=0
    local spinner_char

    local output_file
    output_file=$(mktemp)
    eval "$cmd" >"$output_file" 2>&1 &
    local pid=$!

    while kill -0 "$pid" 2>/dev/null; do
        case $i in
            0) spinner_char="⠋" ;;
            1) spinner_char="⠙" ;;
            2) spinner_char="⠹" ;;
            3) spinner_char="⠸" ;;
            4) spinner_char="⠼" ;;
            5) spinner_char="⠴" ;;
            6) spinner_char="⠦" ;;
            7) spinner_char="⠧" ;;
            8) spinner_char="⠇" ;;
            9) spinner_char="⠏" ;;
        esac
        printf "${CLEAR_LINE}  ${TEXT}%s %s...${RESET}" "$spinner_char" "$msg"
        i=$(((i + 1) % 10))
        sleep 0.08
    done

    wait "$pid"
    local exit_code=$?
    local output
    output=$(cat "$output_file")
    rm "$output_file"

    if [ $exit_code -eq 0 ]; then
        printf "${CLEAR_LINE}  ${GREEN}✔${RESET}${TEXT} %s${RESET}\n" "$success_msg"
    else
        printf "${CLEAR_LINE}  ${RED}✖${RESET}${TEXT} %s... Failed${RESET}\n" "$msg"
        printf '%s\n' "$output" | while IFS= read -r line; do
            printf "    ${RED}|${RESET} ${TEXT}%s${RESET}\n" "$line"
        done
        exit 1
    fi
}

check_and_configure_ports() {
    info "Checking network ports and firewall"
    local ports_to_check="80 443 3000 8080"
    local allowed_processes="caddy epoxy-server bun"

    for port in $ports_to_check; do
        if ss -tlpn | grep -q ":$port\b"; then
            local process_info
            process_info=$(ss -tlpn | grep ":$port\b")
            local process_name
            process_name=$(echo "$process_info" | grep -o 'users:(("[^"]*"' | sed 's/users:(("//;s/"$//')
            
            local is_allowed=false
            if [ -n "$process_name" ]; then
                for allowed_proc in $allowed_processes; do
                    if [ "$process_name" = "$allowed_proc" ]; then
                        is_allowed=true
                        break
                    fi
                done
            fi

            if [ "$is_allowed" = "true" ]; then
                success "Port $port is already used by a required process ($process_name), skipping..."
            else
                error "Port $port is already in use by an unrelated process" "Process details: $process_info"
            fi
        fi
    done

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
        info "UFW firewall detected! Configuring rules..."
        for port in $ports_to_check; do
            if ! sudo ufw status | grep -q "$port/tcp"; then
                run_task "Allowing port $port/tcp through UFW" "Port $port/tcp allowed" "sudo ufw allow $port/tcp"
            else
                success "Port $port/tcp is already allowed"
            fi
        done
    fi
}

clear
printf "${MAUVE}"
cat <<'EOF'
   |\      _,,,---,,_
   /, `.-'`'    -.  ;-;;,_
  |,4-  ) )-,_..;\ (  `'-'
 '---''(_/--'  `-`\_)
   discord.gg/dJvdkPRheV
EOF
printf "${RESET}\n\n"

check_and_configure_ports

info "Checking dependencies"

dependencies_needed=false
if ! command -v unzip >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1 || ! $HOME/.bun/bin/bun pm -g ls | grep -q 'pm2@' || ! command -v cargo >/dev/null 2>&1 || ! dpkg-query -l 2>/dev/null | grep -q caddy; then
  dependencies_needed=true
fi

if [ "$dependencies_needed" = true ]; then
  run_task "Installing missing dependencies" "Dependencies installed" '
    if ! command -v unzip >/dev/null 2>&1; then
      sudo apt-get update -y >/dev/null 2>&1 && sudo apt-get install -y unzip >/dev/null 2>&1
    fi
    if ! command -v bun >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    if ! $HOME/.bun/bin/bun pm -g ls | grep -q "pm2@"; then
      $HOME/.bun/bin/bun add -g pm2 >/dev/null 2>&1
    fi
    if ! command -v cargo >/dev/null 2>&1; then
      curl https://sh.rustup.rs -sSf | sh -s -- -y >/dev/null 2>&1
      export PATH="$HOME/.cargo/bin:$PATH"
    fi
    if ! dpkg-query -l 2>/dev/null | grep -q caddy; then
      sudo apt-get update -y >/dev/null 2>&1
      sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https git build-essential pkg-config libssl-dev >/dev/null 2>&1
      curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg >/dev/null 2>&1
      curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null 2>&1
      sudo apt-get update -y >/dev/null 2>&1
      sudo apt-get install -y caddy >/dev/null 2>&1
    fi
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
      sudo apt-get install -y nodejs >/dev/null 2>&1
    fi
  '
  export PATH="$HOME/.bun/bin:$PATH"
else
  success "All dependencies are already installed"
fi

info "Tuning system"
if grep -q "net.core.somaxconn = 65535" /etc/sysctl.d/99-waves-optimizations.conf 2>/dev/null; then
  success "Kernel optimizations already applied"
else
  run_task "Applying kernel optimizations" "Kernel optimizations applied" '
    cat <<EOF | sudo tee /etc/sysctl.d/99-waves-optimizations.conf
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
fs.file-max = 1048576
fs.nr_open = 1048576
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
    sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf >/dev/null 2>&1
  '
fi

if grep -q "net.ipv4.tcp_congestion_control = bbr" /etc/sysctl.d/99-waves-optimizations.conf 2>/dev/null; then
  success "TCP BBR is already enabled"
else
  run_task "Enabling TCP BBR" "TCP BBR enabled" '
    cat <<EOF | sudo tee -a /etc/sysctl.d/99-waves-optimizations.conf

net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
    sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf >/dev/null 2>&1
  '
fi

if grep -q "^\* hard nofile 1048576" /etc/security/limits.conf 2>/dev/null; then
  success "User file descriptor limits are already configured"
else
  run_task "Increasing user file descriptor limits" "User limits configured" '
    if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
      echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf
    fi
    if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
      echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf
    fi
  '
fi
warn "A reboot may be required for all system optimizations to take full effect"

info "Setting up epoxy-server"
if [ ! -d "$HOME/epoxy-tls" ]; then
    run_task "Cloning repository" "Repository cloned" "git clone https://github.com/MercuryWorkshop/epoxy-tls.git '$HOME/epoxy-tls'"
else
    cd "$HOME/epoxy-tls"
    run_task "Updating repository" "Repository updated" "git pull"
fi

run_task "Compiling" "Compiled" '
  cd "$HOME/epoxy-tls"

  if ! grep -q "^\[profile.release\]" Cargo.toml; then
      printf "\n[profile.release]\n" >> Cargo.toml
  fi
  if ! grep -q "^lto = " Cargo.toml; then
      sed -i "/^\[profile.release\]/a lto = \"fat\"" Cargo.toml
  fi
  if ! grep -q "^codegen-units = " Cargo.toml; then
      sed -i "/^\[profile.release\]/a codegen-units = 1" Cargo.toml
  fi
  if ! grep -q "^panic = " Cargo.toml; then
      sed -i "/^\[profile.release\]/a panic = \"abort\"" Cargo.toml
  fi
  
  RUSTFLAGS="-C target-cpu=native" "$HOME/.cargo/bin/cargo" build --release
  sudo cp "$HOME/epoxy-tls/target/release/epoxy-server" /usr/local/bin/epoxy-server
'
cd - >/dev/null 2>&1

info "Getting Waves ready"
run_task "Installing and building" "Built successfully" '
  cd "$HOME/waves"
  bun install && bun run build
'

info "Creating configuration files"
run_task "Creating configuration files (Caddy, Epoxy, PM2)" "Configuration files created" '
  sudo mkdir -p /etc/epoxy-server
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{
    email sefiicc@gmail.com
}
:443 {
    tls {
        on_demand
    }
    @websockets {
        path /w/*
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websockets http://localhost:8080
    reverse_proxy http://localhost:3000
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "ALLOWALL"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "no-referrer"
    }
}
:80 {
    redir https://{host}{uri} permanent
}
EOF

  sudo tee /etc/epoxy-server/config.toml >/dev/null <<EOF
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
buffer_size = 524288
prefix = "/w"
wisp_v2 = true
extensions = ["udp", "motd"]
password_extension_required = true
certificate_extension_required = true
[stream]
tcp_nodelay = true
buffer_size = 524288
allow_udp = true
allow_wsproxy_udp = false
dns_servers = ["1.1.1.3", "1.0.0.3"]
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
  tee ecosystem.config.cjs >/dev/null <<EOF
module.exports = {
  apps: [
    {
      name: "waves",
      script: "bun",
      args: "start",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "4G",
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "epoxy-server",
      script: "/usr/local/bin/epoxy-server",
      args: "/etc/epoxy-server/config.toml",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "4G"
    }
  ]
};
EOF
'

info "Checking services"
run_task "Configuring and starting services" "All services are up and running" '
  sudo caddy fmt --overwrite /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo systemctl restart caddy
  "$HOME/.bun/bin/pm2" start ecosystem.config.cjs
  "$HOME/.bun/bin/pm2" save
  sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"
'

info "Setup completed! Your Waves instance is now up and ready to be used!!!!"