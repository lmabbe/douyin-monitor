#!/usr/bin/env bash
# 抖音直播监控 - 管理脚本

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.monitor.pid"
LOG_FILE="$DIR/monitor.log"
OUT_LOG="$DIR/monitor.out"

cd "$DIR"

export NODE_OPTIONS="--dns-result-order=ipv4first"

# ---------- 颜色 ----------
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m'

# ---------- 工具 ----------
get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  fi
}

is_running() {
  local pid=$(get_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

# ---------- start ----------
cmd_start() {
  if is_running; then
    echo -e "${YELLOW}[!] 已在运行 (PID $(get_pid))${NC}"
    return 1
  fi

  rm -f "$PID_FILE"

  echo -e "${BLUE}[*] 启动监控...${NC}"

  nohup npx tsx src/index.ts > "$OUT_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 3

  if is_running; then
    echo -e "${GREEN}[ok] 启动成功 (PID $pid)${NC}"
    echo -e "${BLUE}   日志: $OUT_LOG${NC}"
    echo -e "${BLUE}   查看: ./manage.sh log${NC}"
  else
    echo -e "${RED}[!] 启动失败，检查日志:${NC}"
    tail -20 "$OUT_LOG"
    rm -f "$PID_FILE"
    return 1
  fi
}

# ---------- stop ----------
cmd_stop() {
  if ! is_running; then
    echo -e "${YELLOW}[!] 未在运行${NC}"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid=$(get_pid)
  echo -e "${BLUE}[*] 停止监控 (PID $pid)...${NC}"

  kill -TERM "$pid" 2>/dev/null

  local i=0
  while [ $i -lt 20 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
    i=$((i + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo -e "${YELLOW}[!] 优雅退出超时，强制终止${NC}"
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi

  pkill -f "tsx src/index.ts" 2>/dev/null
  pkill -f "whisper-cli" 2>/dev/null
  pkill -f "ffmpeg.*pull-" 2>/dev/null

  rm -f "$PID_FILE"
  echo -e "${GREEN}[ok] 已停止${NC}"
}

# ---------- status ----------
cmd_status() {
  echo -e "${BLUE}===== 抖音直播监控状态 =====${NC}"

  if is_running; then
    local pid=$(get_pid)
    echo -e "  状态: ${GREEN}运行中${NC}"
    echo -e "  PID:  $pid"

    local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$uptime" ] && echo -e "  运行: $uptime"

    local rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$rss" ]; then
      echo -e "  内存: $((rss / 1024)) MB"
    fi
  else
    echo -e "  状态: ${RED}未运行${NC}"
  fi

  echo ""
  echo -e "${BLUE}----- 子进程 -----${NC}"
  local n=0
  for name in "whisper-cli" "ffmpeg.*pull-"; do
    local count=$(pgrep -f "$name" 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
      echo -e "  ${GREEN}$name${NC}: $count 个"
      n=$((n + 1))
    fi
  done
  [ "$n" -eq 0 ] && echo "  （无）"

  echo ""
  echo -e "${BLUE}----- 最近日志 -----${NC}"
  if [ -f "$OUT_LOG" ]; then
    tail -5 "$OUT_LOG" | sed 's/^/  /'
  else
    echo "  （无日志）"
  fi

  echo ""
  echo -e "${BLUE}----- 记录文件 -----${NC}"
  if [ -d "records" ]; then
    local dirs=$(find records -mindepth 2 -maxdepth 2 -type d 2>/dev/null | wc -l)
    local m4a=$(find records -name "*.m4a" 2>/dev/null | wc -l)
    local txt=$(find records -name "summary.txt" 2>/dev/null | wc -l)
    echo -e "  主播目录: $dirs"
    echo -e "  切片文件: $m4a 个 .m4a"
    echo -e "  总结文件: $txt 个 summary.txt"
  fi
}

# ---------- log ----------
cmd_log() {
  if [ ! -f "$OUT_LOG" ]; then
    echo -e "${YELLOW}[!] 无日志文件${NC}"
    return 1
  fi

  case "$1" in
    follow|-f)
      echo -e "${BLUE}[*] 实时日志 (Ctrl+C 退出)${NC}"
      tail -f "$OUT_LOG"
      ;;
    "")
      echo -e "${BLUE}[*] 最近 30 行：${NC}"
      tail -30 "$OUT_LOG"
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        tail -"$1" "$OUT_LOG"
      else
        echo -e "${YELLOW}[!] 未知参数: $1${NC}"
        echo "用法: ./manage.sh log [行数|follow]"
        return 1
      fi
      ;;
  esac
}

# ---------- reload ----------
cmd_reload() {
  echo -e "${BLUE}[*] 触发配置热重载...${NC}"
  if ! is_running; then
    echo -e "${YELLOW}[!] 未在运行${NC}"
    return 1
  fi
  touch "$DIR/.reload"
  echo -e "${GREEN}[ok] 已触发，2 秒后查看日志: ./manage.sh log 10${NC}"
}

# ---------- restart ----------
cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

# ---------- tail ----------
cmd_tail() {
  if [ ! -f "$OUT_LOG" ]; then
    echo -e "${YELLOW}[!] 无日志文件${NC}"
    return 1
  fi
  echo -e "${BLUE}[*] 实时过滤日志（只显示关键行，Ctrl+C 退出）${NC}"
  tail -f "$OUT_LOG" | grep --line-buffered -E "LIVE|OFFLINE|segment|ASR|summary|wechat|ERROR|WARN|总结"
}

# ---------- clean ----------
cmd_clean() {
  read -p "确认清理日志文件？(y/N) " ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    > "$OUT_LOG"
    > "$LOG_FILE"
    echo -e "${GREEN}[ok] 日志已清空${NC}"
  else
    echo "取消"
  fi
}

# ---------- login（扫码添加新微信账号） ----------
cmd_login() {
  echo -e "${BLUE}[*] 微信扫码登录新账号${NC}"
  echo -e "${BLUE}    可选参数: --name 备注名 --subs tag1,tag2${NC}"
  echo ""
  npx tsx src/wechat/sender.ts "$@"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo -e "${GREEN}[ok] 登录完成${NC}"
    echo -e "${YELLOW}[!] 若主程序正在运行，请执行 ./manage.sh restart 使其生效${NC}"
  else
    echo -e "${RED}[!] 登录失败 (exit $rc)${NC}"
  fi
  return $rc
}

# ---------- accounts（列出所有账号） ----------
cmd_accounts() {
  npx tsx -e '
    import { loadAccounts } from "./src/wechat.js";
    const list = loadAccounts();
    if (!list.length) { console.log("（无账号，运行 ./manage.sh login 添加）"); process.exit(0); }
    console.log(`共 ${list.length} 个账号:\n`);
    for (const a of list) {
      const subs = a.subscriptions?.length ? a.subscriptions.join(", ") : "(全部)";
      console.log(`  [${a.name || "-"}] ${a.id}`);
      console.log(`      订阅: ${subs}`);
      console.log(`      目标: ${a.targetUserId || "(未捕获，等待对方发消息)"}`);
      console.log("");
    }
  '
}

# ---------- sub（修改订阅） ----------
cmd_sub() {
  local who="$1"
  local subs="$2"
  if [ -z "$who" ] || [ -z "$subs" ]; then
    echo "用法: ./manage.sh sub <accountId|name> tag1,tag2"
    echo "      tag 传 * 表示全部（清空订阅）"
    return 1
  fi
  npx tsx -e "
    import { loadAccounts, updateSubscriptions } from './src/wechat.js';
    const who = process.argv[1];
    const subsArg = process.argv[2];
    const list = loadAccounts();
    const acc = list.find(a => a.id === who || a.name === who);
    if (!acc) { console.error('未找到账号: ' + who); process.exit(1); }
    const subs = subsArg === '*' ? [] : subsArg.split(',').map(s => s.trim()).filter(Boolean);
    updateSubscriptions(acc.id, subs);
    console.log('已更新 [' + (acc.name||acc.id) + '] 订阅: ' + (subs.length ? subs.join(', ') : '(全部)'));
  " "$who" "$subs"
}

# ---------- usage ----------
usage() {
  cat << EOF
抖音直播监控 - 管理脚本

用法: ./manage.sh <命令>

命令:
  start                           启动监控（后台运行）
  stop                            停止监控
  restart                         重启监控
  reload                          热重载 anchors.json（不重启）
  status                          查看运行状态
  log [N]                         查看最近 N 行日志（默认 30）
  log follow                      实时查看日志（等同 tail -f）
  tail                            实时查看关键日志（过滤版）
  clean                           清空日志

  login [--name N] [--subs a,b]   扫码登录新微信账号（可指定备注名和订阅）
  accounts                        列出所有微信账号及订阅
  sub <id|name> <tag1,tag2>       修改某账号订阅（tag 传 * 表示全部）

示例:
  ./manage.sh start
  ./manage.sh status
  ./manage.sh log follow
  ./manage.sh tail

  ./manage.sh login --name 主号 --subs 游戏,带货
  ./manage.sh login --name 小号
  ./manage.sh accounts
  ./manage.sh sub 主号 游戏,带货,户外
  ./manage.sh sub 小号 *

EOF
}

# ---------- 入口 ----------
case "$1" in
  start)        cmd_start ;;
  stop)         cmd_stop ;;
  restart)      cmd_restart ;;
  reload)       cmd_reload ;;
  status|st)    cmd_status ;;
  log)          shift; cmd_log "$@" ;;
  tail)         cmd_tail ;;
  clean)        cmd_clean ;;
  login)        shift; cmd_login "$@" ;;
  accounts|acc) cmd_accounts ;;
  sub)          shift; cmd_sub "$@" ;;
  ""|help|-h|--help) usage ;;
  *)            echo -e "${RED}[!] 未知命令: $1${NC}"; echo ""; usage; exit 1 ;;
esac