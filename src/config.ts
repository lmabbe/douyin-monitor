/**
 * 全局配置：从 .env 读取，集中管理
 */
import path from 'path';

// ========== 间隔 ==========
export const CHECK_INTERVAL_MS = 30_000;
export const OFFLINE_THRESHOLD = 3;
export const STREAM_FAIL_LIMIT = 5;
export const CHECK_FAIL_LIMIT = 3;
export const ERROR_COOLDOWN_MS = 5 * 60_000;

// ========== 路径 ==========
export const RECORDS_DIR = path.join(process.cwd(), 'records');
export const WECHAT_CRED_FILE = path.join(process.cwd(), '.wechat-cred.json');
export const OUTBOX_FILE = path.join(process.cwd(), 'outbox.jsonl');
export const RELOAD_SIGNAL = path.join(process.cwd(), '.reload');

// ========== ASR ==========
export const ASR_MODE = process.env.ASR_MODE || 'segment';
export const SEGMENT_MINUTES = Number(process.env.SEGMENT_MINUTES || '2');
export const SEGMENT_SECONDS = Math.max(30, SEGMENT_MINUTES * 60);
export const STREAM_FLUSH_MINUTES = Number(
  process.env.STREAM_FLUSH_MINUTES || process.env.SEGMENT_MINUTES || '4'
);
export const AI_SUMMARY_EVERY = Math.max(1, Number(process.env.AI_SUMMARY_EVERY || '4'));

// ========== 视频检查间隔 ==========
/**
 * 解析 VIDEO_CHECK_MINUTES：
 *   - "5"      → 固定 5 分钟
 *   - "5,10"   → 5~10 分钟随机
 *   - 不填     → 默认 5~10
 */
function parseVideoCheckRange(): { minMs: number; maxMs: number } {
  const raw = (process.env.VIDEO_CHECK_MINUTES || '5,10').trim();
  const parts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (parts.length === 0) return { minMs: 5 * 60_000, maxMs: 10 * 60_000 };
  if (parts.length === 1) {
    const fixed = parts[0] * 60_000;
    return { minMs: fixed, maxMs: fixed };
  }
  const a = parts[0] * 60_000;
  const b = parts[1] * 60_000;
  return a <= b ? { minMs: a, maxMs: b } : { minMs: b, maxMs: a };
}

export const VIDEO_RANGE = parseVideoCheckRange();

/** [minMs, maxMs] 之间的随机毫秒数（精确到秒） */
export function nextVideoDelay(): number {
  const { minMs, maxMs } = VIDEO_RANGE;
  if (minMs === maxMs) return minMs;
  const minSec = Math.ceil(minMs / 1000);
  const maxSec = Math.floor(maxMs / 1000);
  const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
  return sec * 1000;
}