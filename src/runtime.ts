/**
 * 主播运行时状态 + 错误处理工具
 *
 * 依赖：config.ts, logger.ts, douyin/types.ts
 */
import { Anchor, AnchorState, LiveInfo } from './douyin/types.js';
import { logger } from './logger.js';
import { ERROR_COOLDOWN_MS } from './config.js';
import { Recorder } from './recorder/recorder.js';
import { StreamRecorder } from './recorder/stream-recorder.js';

export interface AnchorRuntime {
  anchor: Anchor;
  state: AnchorState;
  offlineCount: number;
  streamFailCount: number;
  checkFailCount: number;
  lastErrorAt: number;
  lastErrorReason: string;
  currentRoomId: string | null;
  currentLiveDir: string | null;
  recorder: Recorder | null;
  streamRecorder: StreamRecorder | null;
  liveNotified: boolean;
}

/** 全局主播运行时表（模块级单例，所有模块共享） */
export const runtimes = new Map<string, AnchorRuntime>();

/** 切片计数（onSegmentReady 用） */
export const segmentCounters = new Map<string, number>();

/**
 * 创建初始 AnchorRuntime
 * @param a 主播配置
 * @param recorderFactory 创建 recorder 的工厂（避免 runtime.ts 依赖 recorder 具体实现）
 */
export function createRuntime(
  a: Anchor,
  recorderFactory: () => Recorder,
  streamRecorderFactory: () => StreamRecorder
): AnchorRuntime {
  return {
    anchor: a,
    state: AnchorState.OFFLINE,
    offlineCount: 0,
    streamFailCount: 0,
    checkFailCount: 0,
    lastErrorAt: 0,
    lastErrorReason: '',
    currentRoomId: null,
    currentLiveDir: null,
    recorder: recorderFactory(),
    streamRecorder: streamRecorderFactory(),
    liveNotified: false,
  };
}

// ========== 错误格式化 ==========
export function fmtErr(err: any): string {
  if (!err) return '(空错误)';
  const parts: string[] = [];
  if (err.message) parts.push(`message="${err.message}"`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.syscall) parts.push(`syscall=${err.syscall}`);
  if (err.hostname) parts.push(`hostname=${err.hostname}`);
  if (err.address) parts.push(`address=${err.address}:${err.port || ''}`);
  if (err.response) {
    parts.push(`http=${err.response.status}`);
    if (err.response.data) {
      const d =
        typeof err.response.data === 'string'
          ? err.response.data.slice(0, 200)
          : JSON.stringify(err.response.data).slice(0, 200);
      parts.push(`body=${d}`);
    }
  }
  return parts.join(' ');
}

export function fmtLive(live: LiveInfo | undefined | null): string {
  if (!live) return '(无)';
  return [
    `isLive=${live.isLive}`,
    `roomId=${live.roomId || '-'}`,
    `format=${live.streamFormat}`,
    `title="${(live.title || '').slice(0, 30)}"`,
    `hasFlv=${!!live.flvUrl}`,
    `hasHls=${!!live.hlsUrl}`,
    `streamUrl=${live.streamUrl ? live.streamUrl.slice(0, 60) + '...' : '(空)'}`,
  ].join(' ');
}

/** 统一的"进入 ERROR"入口，打完整上下文 */
export function enterError(rt: AnchorRuntime, reason: string): void {
  rt.state = AnchorState.ERROR;
  rt.lastErrorAt = Date.now();
  rt.lastErrorReason = reason;
  logger.error(
    rt.anchor.name,
    `[STATE] -> ERROR | reason="${reason}" | webRid=${rt.anchor.webRid} | ` +
      `checkFail=${rt.checkFailCount} | streamFail=${rt.streamFailCount} | ` +
      `冷却 ${ERROR_COOLDOWN_MS / 60000} 分钟后自动重试`
  );
}