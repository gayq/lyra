#!/bin/bash

BLUE='\033[1;38;2;137;180;250m'
GREEN='\033[1;38;2;166;227;161m'
RED='\033[1;38;2;243;139;168m'
MAUVE='\033[1;38;2;203;166;247m'
YELLOW='\033[1;38;2;250;227;118m'
TEXT='\033[0;38;2;205;214;244m'
RESET='\033[0m'
CLEAR_LINE='\r\033[K'

VENV_PATH="$HOME/waves/.venv"


styled_prefix() {
  local prefix_text=$1
  local prefix_color=$2
  printf "${prefix_color}%-4s${RESET}" " $prefix_text"
}

info() {
  local prefix
  prefix=$(styled_prefix "info" "$BLUE")
  printf "\n%s ${TEXT}%s${RESET}\n" "$prefix" "$1"
}

task_category() {
  local prefix
  prefix=$(styled_prefix "$1" "$YELLOW")
  printf "\n%s ${TEXT}%s${RESET}\n" "$prefix" "$2"
}

task_success() {
  local prefix
  prefix=$(styled_prefix "info" "$BLUE")
  printf "%s ${GREEN}✔${RESET}${TEXT} %s${RESET}\n" "$prefix" "$1"
}

done_message() {
  local prefix
  prefix=$(styled_prefix "done" "$GREEN")
  printf "\n%s ${TEXT}%s${RESET}\n" "$prefix" "$1"
}

error() {
  local prefix
  prefix=$(styled_prefix "FAIL" "$RED")
  printf "${CLEAR_LINE}%s ${TEXT}%s... Failed${RESET}\n" "$prefix" "$1"
  if [ -n "$2" ]; then
    printf "    ${RED}|${RESET} ${TEXT}%s${RESET}\n" "$2"
  fi
  exit 1
}

warn() {
  local prefix
  prefix=$(styled_prefix "WARN" "$RED")
  printf "%s ${TEXT}%s${RESET}\n" "$prefix" "$1"
}

run_task() {
    local category=$1
    local msg=$2
    local success_msg=$3
    local cmd=$4
    local i=0
    local spinner_char
    local prefix
    prefix=$(styled_prefix "$category" "$YELLOW")

    local output_file
    output_file=$(mptemp) 
    
    ( eval "$cmd" ) >"$output_file" 2>&1 &
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
        printf "${CLEAR_LINE}%s ${TEXT}%s %s...${RESET}" "$prefix" "$spinner_char" "$msg"
        i=$(((i + 1) % 10))
        sleep 0.08
    done

    wait "$pid"
    local exit_code=$?
    local output
    output=$(cat "$output_file")
    rm "$output_file"

    if [ $exit_code -eq 0 ]; then
        printf "${CLEAR_LINE}%s ${GREEN}✔${RESET}${TEXT} %s${RESET}\n" "$prefix" "$success_msg"
    else
        printf "${CLEAR_LINE}%s ${RED}✖${RESET}${TEXT} %s... Failed${RESET}\n" "$prefix" "$msg"
        printf '%s\n' "$output" | while IFS= read -r line; do
            printf "    ${RED}|${RESET} ${TEXT}%s${RESET}\n" "$line"
        done
        exit 1
    fi
}

configure_caddy_no_proxy() {
    local OVERRIDE_DIR="/etc/systemd/system/caddy.service.d"
    local OVERRIDE_PATH="$OVERRIDE_DIR/override.conf"
    local NO_PROXY_VALUE="127.0.0.1"

    if [ ! -d "$OVERRIDE_DIR" ]; then
        sudo mkdir -p "$OVERRIDE_DIR"
    fi

    sudo tee "$OVERRIDE_PATH" > /dev/null <<EOF
[Service]
Environment="NO_PROXY=$NO_PROXY_VALUE"
EOF

    sudo systemctl daemon-reload
}

create_config_files() {
  sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
{
    email sefiicc@gmail.com
    
    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
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

  tee ecosystem.config.cjs >/dev/null <<EOF
module.exports = {
  apps: [
    {
      name: "ask",
      script: "bun",
      args: "run ask.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "100M"
    },
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
      name: "wireproxy",
      script: "/usr/local/bin/wireproxy",
      args: ["-c", "/etc/wireproxy/wireproxy.conf"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G"
    },
    {
      name: "wisp-server-python",
      script: "$VENV_PATH/bin/python3", 
      args: ["wisp-server-python/server.py", "--port", "8080", "--host", "0.0.0.0", "--log-level", "info", "--threads", "4"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      cwd: "$HOME/waves" 
    }
  ]
};
EOF
}

check_and_configure_ports() {
    info "Checking network ports and firewall"
    local ports_to_check="80 443 3000 8080"
    local ufw_ports_to_open="80 443 3000 8080"
    local allowed_processes="caddy wisp-server-python bun wireproxy python3"

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
                printf "%s ${GREEN}✔${RESET}${TEXT} Port %s is already used by a required process (%s), skipping...${RESET}\n" "$(styled_prefix 'port' "$GREEN")" "$port" "$process_name"
            else
                error "Port $port is already in use by an unrelated process" "Process details: $process_info"
            fi
        fi
    done

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
        info "UFW firewall detected! Configuring rules..."
        for port in $ufw_ports_to_open; do
            if ! sudo ufw status | grep -q "$port/tcp"; then
                run_task "ufw" "Allowing port $port/tcp through UFW" "Port $port/tcp allowed" "sudo ufw allow $port/tcp"
            else
                printf "%s ${GREEN}✔${RESET}${TEXT} Port %s/tcp is already allowed${RESET}\n" "$(styled_prefix 'ufw' "$GREEN")" "$port"
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

if [ -d "$HOME/.bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

check_and_configure_ports

task_category "deps" "Checking dependencies"

dependencies_needed=false
if ! command -v unzip >/dev/null 2>&1 || \
   ! command -v bun >/dev/null 2>&1 || \
   ! $HOME/.bun/bin/bun pm -g ls | grep -q 'pm2@' || \
   ! command -v setcap >/dev/null 2>&1 || \
   ! dpkg-query -l 2>/dev/null | grep -q caddy || \
   ! command -v jq >/dev/null 2>&1 || \
   ! command -v dig >/dev/null 2>&1 || \
   ! command -v python3 >/dev/null 2>&1 || \
   ! dpkg-query -l 2>/dev/null | grep -q python3-venv; then
  dependencies_needed=true
fi

if [ "$dependencies_needed" = true ]; then
  run_task "deps" "Installing missing dependencies and preparing virtual environment" "Dependencies installed and environment prepared" '
    sudo apt-get update -y

    sudo apt-get install -y unzip libcap2-bin jq dnsutils python3 python3-pip python3-venv

    if ! command -v bun >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash
    fi
    export PATH="$HOME/.bun/bin:$PATH"
    
    bun add -g pm2
    
    if ! dpkg-query -l 2>/dev/null | grep -q caddy; then
      sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https git build-essential pkg-config libssl-dev jq dnsutils
      curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
      sudo apt-get update -y
      sudo apt-get install -y caddy
    fi

    python3 -m venv "$VENV_PATH"
  '
else
  task_success "All dependencies are already installed"
fi

task_category "wire" "Setting up WireProxy"

WGCF_LATEST_URL=$(curl -s https://api.github.com/repos/ViRb3/wgcf/releases/latest | jq -r '.assets[] | select(.name | endswith("_linux_amd64")) | .browser_download_url')
WIREPROXY_LATEST_URL=$(curl -s https://api.github.com/repos/whyvl/wireproxy/releases/latest | jq -r '.assets[] | select(.name | endswith("_linux_amd64.tar.gz")) | .browser_download_url')

run_task "wire" "Installing WireProxy and WGCF" "Binaries installed" "
    curl -L -o wgcf \"$WGCF_LATEST_URL\"
    chmod +x wgcf
    sudo mv wgcf /usr/local/bin/wgcf

    curl -L -o wireproxy.tar.gz \"$WIREPROXY_LATEST_URL\"
    tar -xzf wireproxy.tar.gz
    chmod +x wireproxy
    sudo mv wireproxy /usr/local/bin/wireproxy
    rm wireproxy.tar.gz
    sudo setcap cap_net_admin+eip /usr/local/bin/wireproxy
"

if [ ! -f "/etc/wireproxy/wireproxy.conf" ]; then
    run_task "wire" "Generating Cloudflare WARP config" "WireGuard config created" '
        sudo mkdir -p /etc/wireproxy
        wgcf register --accept-tos
        wgcf generate

        ENDPOINT_LINE=`grep "Endpoint" wgcf-profile.conf`
        HOSTNAME=`echo $ENDPOINT_LINE | cut -d " " -f 3 | cut -d ":" -f 1`
        PORT=`echo $ENDPOINT_LINE | cut -d " " -f 3 | cut -d ":" -f 2`

        IP=`dig +short $HOSTNAME | head -n 1`

        grep -v -e "^DNS" -e "^MTU" wgcf-profile.conf | sudo tee /etc/wireproxy/wireproxy.conf

        sudo sed -i "s|$HOSTNAME:$PORT|$IP:$PORT|" /etc/wireproxy/wireproxy.conf

        cat <<WG_TUN | sudo tee -a /etc/wireproxy/wireproxy.conf >/dev/null

[TUN]
DeviceName = wg-tun
Address = 172.16.0.2/24
DNS = 1.1.1.1, 94.140.14.14
RouteAll = true
WG_TUN

        rm wgcf-profile.conf
    '
else
    task_success "WireGuard configuration already exists"
fi

task_category "tune" "Tuning system"
if grep -q "net.core.somaxconn = 65535" /etc/sysctl.d/99-waves-optimizations.conf 2>/dev/null; then
  task_success "Kernel optimizations already applied"
else
  run_task "tune" "Applying kernel optimizations" "Kernel optimizations applied" '
    cat <<EOF | sudo tee /etc/sysctl.d/99-waves-optimizations.conf >/dev/null
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
fs.file-max = 1048576
vm.swappiness = 10
EOF
    sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf
  '
fi

if grep -q "net.ipv4.tcp_congestion_control = bbr" /etc/sysctl.d/99-waves-optimizations.conf 2>/dev/null; then
  task_success "TCP BBR is already enabled"
else
  run_task "tune" "Enabling TCP BBR" "TCP BBR enabled" '
    cat <<EOF | sudo tee -a /etc/sysctl.d/99-waves-optimizations.conf >/dev/null

net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
    sudo sysctl -p /etc/sysctl.d/99-waves-optimizations.conf
  '
fi

if grep -q "^\* hard nofile 1048576" /etc/security/limits.conf 2>/dev/null; then
  task_success "User file descriptor limits are already configured"
else
  run_task "tune" "Increasing user file descriptor limits" "User limits configured" '
    if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
      echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf >/dev/null
    fi
    if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
      echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf >/dev/null
    fi
  '
fi
warn "A reboot may be required for all system optimizations to take full effect"

task_category "build" "Getting Waves ready"
run_task "build" "Building Waves" "Built successfully" '
  cd "$HOME/waves"
  export PATH="$HOME/.bun/bin:$PATH"
  bun install && bun run build
'

task_category "conf" "Creating configuration files"
run_task "conf" "Creating config files" "Configuration files created" "create_config_files"

task_category "svc" "Checking services"
run_task "svc" "Configuring and starting services" "All services are up and running" '
  configure_caddy_no_proxy
  sudo caddy fmt --overwrite /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo systemctl restart caddy

  "$HOME/.bun/bin/pm2" start ecosystem.config.cjs --update-env

  PROCESS_COUNT=$("$HOME/.bun/bin/pm2" jlist | jq length)
  
  if [ "$PROCESS_COUNT" -lt 4 ]; then
    echo "PM2 started $PROCESS_COUNT processes, expected 4. PM2 list output:"
    "$HOME/.bun/bin/pm2" list
    exit 1
  fi

  "$HOME/.bun/bin/pm2" save
  sudo env PATH=$PATH:$HOME/.bun/bin "$HOME/.bun/bin/pm2" startup systemd -u "$USER" --hp "$HOME"
'

done_message "Setup completed! Your Waves instance is now up and ready to be used!"