#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/next.pid"

stop_next() {
  [[ -f "$PID_FILE" ]] || return 0

  local pid
  pid="$(<"$PID_FILE")"
  rm -f "$PID_FILE"

  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "停止 Next.js，PID: $pid"
  kill "$pid" 2>/dev/null || true

  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done

  echo "Next.js 未在 10 秒内退出，发送强制终止信号"
  kill -9 "$pid" 2>/dev/null || true
}

stop_next

echo "停止 PostgreSQL..."
docker compose -f "$ROOT_DIR/docker-compose.yml" stop postgres

echo "服务已停止"
