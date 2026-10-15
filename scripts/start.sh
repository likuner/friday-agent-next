#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/next.pid"
LOG_FILE="$RUN_DIR/next.log"
DEFAULT_PORT=3333
PORT_SCAN_LIMIT=100

mkdir -p "$RUN_DIR"

is_running() {
  [[ -f "$PID_FILE" ]] || return 1

  local pid
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

port_is_available() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    [[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]]
    return
  fi

  command -v nc >/dev/null 2>&1 || {
    echo "无法检查端口占用：系统缺少 lsof 或 nc" >&2
    return 1
  }
  ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1
}

find_available_port() {
  local start_port="${PORT:-$DEFAULT_PORT}"
  local port

  [[ "$start_port" =~ ^[0-9]+$ ]] && ((start_port >= 1 && start_port <= 65535)) || {
    echo "PORT 必须是 1 到 65535 之间的端口号，当前值：$start_port" >&2
    return 1
  }

  for ((port = start_port; port < start_port + PORT_SCAN_LIMIT && port <= 65535; port++)); do
    if port_is_available "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
  done

  echo "从端口 $start_port 开始，连续 $PORT_SCAN_LIMIT 个端口都已被占用" >&2
  return 1
}

if is_running; then
  echo "Next.js 已在运行，PID: $(<"$PID_FILE")"
  exit 0
fi

rm -f "$PID_FILE"

NEXT_PORT="$(find_available_port)"

echo "启动 PostgreSQL..."
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d

echo "启动 Next.js 开发服务，端口：$NEXT_PORT"
(
  cd "$ROOT_DIR"
  exec "$ROOT_DIR/node_modules/.bin/next" dev -p "$NEXT_PORT" >>"$LOG_FILE" 2>&1
) &

echo $! >"$PID_FILE"

sleep 2
if ! is_running; then
  echo "Next.js 启动失败，请查看日志: $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "服务已启动"
echo "- Next.js: http://localhost:$NEXT_PORT"
echo "- 日志: $LOG_FILE"
echo "- 停止: npm run local:stop"
