import 'dotenv/config';
import WebSocket from 'ws';
import {logger} from "../logger";

// ============================================================
// 配置
// ============================================================

// Gemini API Key（从 .env 读取）
const API_KEY = process.env.GEMINI_API_KEY!;

// 使用的模型，默认 gemini-3.5-transcribe-live（专用实时语音转文字模型）
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live';

// Gemini Live WebSocket 地址
// 注意：key 直接拼在 URL 上，不要写在 Header
const WS_URL =
  `wss://generativelanguage.googleapis.com/ws/` +
  `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
  `?key=${API_KEY}`;

// ============================================================
// 音频参数
// ============================================================

// 每块 PCM 的字节数
// 音频规格：16000 Hz、16 bit（2 字节/采样）、单声道
// 100ms 的字节数 = 16000 × 0.1 × 2 = 3200
// Gemini Live 官方建议约 100ms 一块
const CHUNK_SIZE = 3200;

// 发送间隔（毫秒）
// 每 100ms 发一块 3200 字节，保持"实时节奏"
const CHUNK_INTERVAL_MS = 100;

// ============================================================
// 看门狗（防假死）
// ============================================================

// 多久检查一次连接是否假死
const WATCHDOG_INTERVAL_MS = 5_000;

// 多久没收到任何服务端消息判定为"假死"
// 60 秒是"主播沉默"和"连接假死"的平衡点
const WATCHDOG_TIMEOUT_MS = 45_000;

// ============================================================
// 重连策略
// ============================================================

// 首次重连等待（毫秒）
// 断开后不立刻重连，给服务端时间清理旧连接
const INITIAL_RECONNECT_DELAY_MS = 1000;

// 重连延迟封顶（毫秒）
// 退避序列：2s → 4s → 8s → 16s → 30s → 30s → ...
const MAX_RECONNECT_DELAY_MS = 30_000;

// WebSocket 建连超时
// 防止 new WebSocket() 卡在 CONNECTING 状态（TCP 握手挂住）
const CONNECT_TIMEOUT_MS = 10_000;

// ============================================================
// endStream 超时
// ============================================================

// 下播时等最后一批 transcription 的最长时间
// 收到 turnComplete 或最后一条 inputTranscription 会提前结束
const END_STREAM_TIMEOUT_MS = 5000;

// ============================================================
// PCM 缓冲上限
// ============================================================

// 重连期间最多缓存多少 PCM
// CHUNK_SIZE × 20 = 64000 字节 = 2 秒
// 断线时 FFmpeg 还在推 PCM，先缓存，超出 2 秒就丢最老的
const MAX_PENDING_BYTES = CHUNK_SIZE * 50;

// ============================================================
// 回调接口
// ============================================================

export interface GeminiLiveCallbacks {
  // 收到最终转写（每句完整的话）
  onFinal: (text: string) => void;

  // 收到中间转写（边听边猜，会变化，可选）
  onInterim?: (text: string) => void;

  // 出错回调
  onError?: (err: Error) => void;

  // 重连时回调（用于日志）
  onReconnect?: (reason: string) => void;
}

// ============================================================
// 主类
// ============================================================

export class GeminiLiveTranscriber {
  // WebSocket 实例
  private ws: WebSocket | null = null;

  // 等待发送的 PCM 缓冲
  // 重连期间 FFmpeg 还会推 PCM，先存这里
  private pending = Buffer.alloc(0);

  // 上一次收到的中间结果（用来去重）
  private lastInterim = '';

  // 是否正在停止（stop() 被调用后为 true）
  private shuttingDown = false;

  // setup 是否已完成（setupComplete 收到后为 true）
  // 只有 setupComplete 之后才允许发送音频
  private setupComplete = false;

  // 最后一次收到服务端消息的时间（看门狗用）
  private lastServerMessageTime = 0;

  // 100ms 发送循环的 timer
  private sendTimer: NodeJS.Timeout | null = null;

  // 看门狗 timer
  private watchdogTimer: NodeJS.Timeout | null = null;

  // 重连 timer
  private reconnectTimer: NodeJS.Timeout | null = null;

  // 建连超时 timer
  private connectTimeoutTimer: NodeJS.Timeout | null = null;

  // 连接稳定性 timer（60 秒后重置退避次数）
  private healthyTimer: NodeJS.Timeout | null = null;

  // 是否正在建连（防止并发 connect）
  private connecting = false;

  // 是否正在重连（防止 close 事件重复触发重连）
  private reconnecting = false;

  // 连续重连次数（用于指数退避）
  private reconnectAttempt = 0;

  // endStream 是否已请求（收到最后 transcription 后通知 resolve）
  private endStreamRequested = false;

  // endStream 的 resolve 函数
  private endStreamResolve: (() => void) | null = null;

  constructor(private callbacks: GeminiLiveCallbacks) {}

  // ============================================================
  // 启动
  // ============================================================

  start(): void {
    if (this.shuttingDown) return;
    this.startWatchdog();      // 启动看门狗
    this.startSendLoop();      // 启动 100ms 发送循环
    this.connect('initial');   // 建立第一个连接
  }

  // ============================================================
  // 建连
  // ============================================================

  private connect(reason: string): void {
    if (this.shuttingDown) return;
    if (this.connecting) return;                              // 已在建连
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;  // 已连上

    this.connecting = true;
    this.reconnecting = false;
    this.setupComplete = false;

    logger.sys(`[gemini-live] 连接... (${reason}) reconnectAttempt=${this.reconnectAttempt}`);

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    // 建连超时：10 秒内没 OPEN 就强制重试
    // 解决"CONNECTING 卡死"（TCP 握手挂住，close 事件不触发）
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        logger.sys('[gemini-live] ⚠️ 连接超时（10s），强制重试');
        try { ws.terminate(); } catch {}
        this.connecting = false;
        this.scheduleReconnect(0);
      }
    }, CONNECT_TIMEOUT_MS);

    // ---------- WebSocket OPEN ----------
    ws.on('open', () => {
      if (this.connectTimeoutTimer) {
        clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = null;
      }
      if (this.shuttingDown) { ws.close(); return; }

      this.connecting = false;
      this.setupComplete = false;
      this.lastServerMessageTime = Date.now();

      logger.sys('[gemini-live] ✅ WebSocket 已连接');

      // 发送 setup 消息
      // 注意：不用 sessionResumption（实测会导致假死）
      const setup = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            languageCodes: [],   // 自动检测语言
            mode: 'SMART',       // 智能模式：自动清理口头禅、加标点
          },
        },
      };
      ws.send(JSON.stringify(setup));
      logger.sys('[gemini-live] → setup 已发送');
    });

    // ---------- WebSocket MESSAGE ----------
    ws.on('message', (data: Buffer) => {
      // 任何服务端消息都算"连接活着"
      this.lastServerMessageTime = Date.now();

      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // ---- GoAway：服务端通知会话即将到期（约 10 分钟）----
      if (msg.goAway) {
        const tl = msg.goAway.timeLeft ?? '?';
        logger.sys(`[gemini-live] ⚠️ 收到 GoAway，剩余时间: ${tl}`);
        // 延迟 3 秒主动 close，比等服务端强断更快
        // 这 3 秒还能收到最后一批文本
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            logger.sys('[gemini-live] GoAway 后主动 close');
            try { this.ws.close(); } catch {}
          }
        }, 3000);
        return;
      }

      // ---- setupComplete：连接配置完成 ----
      if (msg.setupComplete) {
        this.setupComplete = true;
        logger.sys('[gemini-live] ✅ Setup 完成');
        this.markHealthy();   // 启动 60 秒稳定性计时器
        return;
      }

      // ---- serverContent：转写结果 ----
      const content = msg.serverContent;
      if (!content) return;

      // 中间结果（会变化，仅用于实时显示）
      if (content.interimInputTranscription) {
        const t = content.interimInputTranscription.text ?? '';
        if (t && t !== this.lastInterim) {
          this.lastInterim = t;
          this.callbacks.onInterim?.(t);
        }
      }

      // 最终结果（一句话完成）
      if (content.inputTranscription) {
        const t = content.inputTranscription.text ?? '';
        if (t) {
          this.callbacks.onFinal(t);
          this.lastInterim = '';
          // 如果 endStream 在等，收到 final 就通知
          if (this.endStreamRequested) this.resolveEndStream();
        }
      }

      // 本轮输入结束
      if (content.turnComplete) {
        if (this.endStreamRequested) this.resolveEndStream();
      }
    });

    // ---------- WebSocket ERROR ----------
    ws.on('error', (error) => {
      logger.sys(`[gemini-live] ❌ WebSocket error: ${error.message}`);
      this.callbacks.onError?.(error);
    });

    // ---------- WebSocket CLOSE ----------
    ws.on('close', (code, reasonBuffer) => {
      if (this.connectTimeoutTimer) {
        clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = null;
      }
      this.connecting = false;

      const reasonText = reasonBuffer?.toString() || '';
      logger.sys(`[gemini-live] 连接关闭 code=${code}${reasonText ? ` reason=${reasonText.slice(0,80)}` : ''}`);

      // 主动 stop 导致的 close，不重连
      if (this.shuttingDown) return;

      // 防止重复触发重连
      if (this.reconnecting) return;

      this.reconnecting = true;
      this.setupComplete = false;
      this.callbacks.onReconnect?.(`close code=${code}`);
      this.scheduleReconnect(code);
    });
  }

  // ============================================================
  // PCM 输入
  // ============================================================

  feed(pcm: Buffer): void {
    if (this.shuttingDown) return;
    if (!pcm || pcm.length === 0) return;

    // 先加到缓冲
    this.pending = Buffer.concat([this.pending, pcm]);

    // 超出上限就丢最老的
    // 重连期间 FFmpeg 会一直推 PCM，不限制会爆内存
    if (this.pending.length > MAX_PENDING_BYTES) {
      const dropBytes = this.pending.length - MAX_PENDING_BYTES;
      this.pending = this.pending.subarray(dropBytes);
    }
  }

  // ============================================================
  // 100ms 发送循环
  // ============================================================

  private startSendLoop(): void {
    if (this.sendTimer) return;
    this.sendTimer = setInterval(() => this.sendOneChunk(), CHUNK_INTERVAL_MS);
  }

  private sendOneChunk(): void {
    if (this.shuttingDown) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;   // 没连接
    if (!this.setupComplete) return;                       // setup 未完成
    if (this.pending.length < CHUNK_SIZE) return;          // 缓冲不足一块

    const piece = this.pending.subarray(0, CHUNK_SIZE);
    try {
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: piece.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }));
      // 发送成功后才从缓冲移除
      this.pending = this.pending.subarray(CHUNK_SIZE);
    } catch (e: any) {
      logger.sys(`[gemini-live] PCM send 失败: ${e.message}`);
    }
  }

  // ============================================================
  // 看门狗（检测假死）
  // ============================================================

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkHealth(), WATCHDOG_INTERVAL_MS);
    logger.sys('[gemini-live] watchdog 已启动');
  }

  private checkHealth(): void {
    if (this.shuttingDown) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;   // 只检查 OPEN 状态
    if (!this.setupComplete) return;                       // setup 未完成不算

    const idleMs = Date.now() - this.lastServerMessageTime;
    if (idleMs < WATCHDOG_TIMEOUT_MS) return;              // 没超时

    // 没 PCM 在等 = 主播可能真的没说话，不算假死
    if (this.pending.length === 0) return;

    logger.sys_error(`[gemini-live] ⚠️ 看门狗：${Math.round(idleMs/1000)}s 无 server message，强制重连`);
    this.forceReconnect('watchdog timeout');
  }

  // ============================================================
  // 强制重连（看门狗触发）
  // ============================================================

  private forceReconnect(reason: string): void {
    if (this.shuttingDown) return;
    if (this.reconnecting) return;

    this.reconnecting = true;
    this.setupComplete = false;
    this.callbacks.onReconnect?.(reason);

    const ws = this.ws;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
        else ws.terminate();
      } catch {}
    }
    // 1 秒后重连（不走指数退避）
    this.scheduleReconnect(1000);
  }

  // ============================================================
  // 指数退避重连
  // ============================================================

  private scheduleReconnect(code: number): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt++;
    // 退避序列：2s, 4s, 8s, 16s, 30s, 30s, ...
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, Math.max(0, this.reconnectAttempt - 1)),
      MAX_RECONNECT_DELAY_MS
    );
    logger.sys(`[gemini-live] ${delay}ms 后重连 (attempt=${this.reconnectAttempt}, 上次 code=${code})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      this.connect(`重连 attempt=${this.reconnectAttempt}`);
    }, delay);
  }

  // ============================================================
  // 连接稳定 60 秒后重置退避次数
  // ============================================================

  private markHealthy(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      if (this.shuttingDown) return;
      this.reconnectAttempt = 0;
      logger.sys('[gemini-live] ✅ 连接稳定运行 60s，reconnectAttempt 已重置');
    }, 60_000);
  }

  // ============================================================
  // endStream
  // ============================================================

  private resolveEndStream(): void {
    if (!this.endStreamResolve) return;
    const resolve = this.endStreamResolve;
    this.endStreamResolve = null;
    resolve();
  }

  // 下播时调用：把缓冲区发完 + 通知 Gemini 音频结束 + 等最后一批 transcription
  async endStream(timeoutMs = END_STREAM_TIMEOUT_MS): Promise<void> {
    if (this.shuttingDown) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // 1. 等缓冲区剩余 PCM 发完（最多 500ms）
    const flushDeadline = Date.now() + 500;
    while (this.pending.length >= CHUNK_SIZE && Date.now() < flushDeadline) {
      await new Promise(r => setTimeout(r, CHUNK_INTERVAL_MS));
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    }

    // 2. 发送不足一块的尾巴
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.setupComplete && this.pending.length > 0) {
      const piece = this.pending;
      this.pending = Buffer.alloc(0);
      try {
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: { data: piece.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
          },
        }));
      } catch {}
    }

    // 3. 发送 audioStreamEnd
    this.endStreamRequested = true;
    try {
      this.ws?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch (e: any) {
      logger.sys_error(`[gemini-live] audioStreamEnd 发送失败: ${e.message}`);
      this.endStreamRequested = false;
      return;
    }

    logger.sys('[gemini-live] → audioStreamEnd 已发送，等待最后 transcription');

    // 4. 等 turnComplete 或超时
    await new Promise<void>((resolve) => {
      this.endStreamResolve = resolve;
      setTimeout(() => {
        if (this.endStreamResolve) {
          logger.sys_error('[gemini-live] ⚠️ 等待最后 transcription 超时');
          this.endStreamResolve = null;
          resolve();
        }
      }, timeoutMs);
    });

    this.endStreamRequested = false;
    logger.sys('[gemini-live] ✅ endStream 完成');
  }

  // ============================================================
  // 获取最后的中间结果（下播 flush 用）
  // ============================================================

  getLastInterim(): string {
    return this.lastInterim;
  }

  // ============================================================
  // 停止
  // ============================================================

  stop(): void {
    this.shuttingDown = true;

    // 清掉所有 timer
    if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
    if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }

    this.connecting = false;
    this.reconnecting = false;
    this.setupComplete = false;
    this.pending = Buffer.alloc(0);

    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      } catch {}
    }

    logger.sys('[gemini-live] 已停止');
  }
}