#!/usr/bin/env bash
# Sobe o proxy de entrada do servidor da casa na porta 80.
# Antes, tira a Blizzard da porta 80 (ela passa a escutar em 127.0.0.1:8080, atrás do proxy).
#
#   cd ~/garcias-home && ./install.sh
#
# Variável opcional: BLIZZARD_DIR (padrão ~/blizzard).
set -euo pipefail

SERVIDOR_DIR="$(cd "$(dirname "$0")" && pwd)"
BLIZZARD_DIR="${BLIZZARD_DIR:-$HOME/blizzard}"
BLIZZARD_LISTEN="127.0.0.1:8080"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não encontrado. Instale com: curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi

if [ -d "$BLIZZARD_DIR" ]; then
  if ! grep -q 'BLIZZARD_WEB_LISTEN' "$BLIZZARD_DIR/nginx.conf" 2>/dev/null; then
    echo "A Blizzard em $BLIZZARD_DIR está desatualizada. Rode antes: cd $BLIZZARD_DIR && git pull" >&2
    exit 1
  fi
  echo "==> Blizzard: porta 80 → $BLIZZARD_LISTEN"
  ENV_FILE="$BLIZZARD_DIR/.env"
  touch "$ENV_FILE"
  if grep -qE '^[[:space:]]*BLIZZARD_WEB_LISTEN=' "$ENV_FILE"; then
    sed -i -E "s|^[[:space:]]*BLIZZARD_WEB_LISTEN=.*|BLIZZARD_WEB_LISTEN=$BLIZZARD_LISTEN|" "$ENV_FILE"
  else
    printf '\n# Atrás do proxy de entrada do servidor da casa (repositório garcias-home).\nBLIZZARD_WEB_LISTEN=%s\n' "$BLIZZARD_LISTEN" >> "$ENV_FILE"
  fi
  (cd "$BLIZZARD_DIR" && sudo docker compose up -d --build web)
else
  echo "==> Blizzard não encontrada em $BLIZZARD_DIR; seguindo só com o proxy."
fi

echo "==> Proxy de entrada (Caddy) na porta 80"
cd "$SERVIDOR_DIR"
sudo docker compose up -d

cat <<MSG

Pronto. Falta:
  1. No DNS da rede (gateway 10.255.200.254), apontar para 10.255.200.100:
       view.blizzard.net, rotina.blizzard.net
  2. Reiniciar o Pi (sudo reboot) para o quiosque da TV abrir a Blizzard na porta nova.

Teste daqui mesmo, sem depender do DNS:
  curl -sI -H 'Host: rotina.blizzard.net' http://127.0.0.1/ | head -1
  curl -sI -H 'Host: view.blizzard.net'   http://127.0.0.1/ | head -1
MSG
