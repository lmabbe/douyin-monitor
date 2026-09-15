import 'dotenv/config';
import WebSocket from 'ws';

const API_KEY = process.env.GEMINI_API_KEY!;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const CHUNK_SIZE = 3200;
const WATCHDOG_IDLE_MS = 15_000;   // 15 秒无文本（有 PCM 时），强制重连
const WATCHDOG_INTERVAL_MS = 5_000;

export interface GeminiLiveCallbacks {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (err: Error) => void;
  onReconnect?: (reason: string) => void;
}

export class GeminiLiveTranscriber {
  private ws: WebSocket | null = null;
  private pending = Buffer.alloc(0);
  private lastInterim = '';
  private endStreamPromise: Promise<void> | null = null;
  private resolveEndStream: (() => void) | null = null;
  private shuttingDown = false;
  private sessionHandle: string | null = null;
  private reconnecting = false;
  private lastTextTime = Date.now();
  private lastPcmTime = Date.now();
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(private callbacks: GeminiLiveCallbacks) {}

  start(): void {
    this.connect('initial');
    this.startWatchdog();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.shuttingDown) return;
      const idleSec = (Date.now() - this.lastTextTime) / 1000;
      // 连接开着但长时间无文本 → 强制断开重连
      const idlePcm = (Date.now() - this.lastPcmTime) / 1000;
      if (idleSec > WATCHDOG_IDLE_MS / 1000 && this.ws?.readyState === WebSocket.OPEN) {
        console.log(`[gemini-live] ⚠️ 看门狗：${idleSec.toFixed(0)}s 无文本，强制重连`);
        try { this.ws.close(); } catch {}
        // 兜底：如果 5 秒后还没触发 close 重连，直接重连
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.reconnecting = false;
            this.connect('看门狗兜底重连');
          }
        }, 5000);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private connect(reason: string): void {
    if (this.shuttingDown) return;
    console.log(`[gemini-live] 连接... (${reason})`);
    this.ws = new WebSocket(WS_URL);
    this.pending = Buffer.alloc(0);
    this.lastInterim = '';
    this.reconnecting = false;
    this.lastTextTime = Date.now();

    this.ws.on('open', () => {
      console.log(`[gemini-live] ✅ 已连接`);
      const setup: any = {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [], mode: 'SMART' },
      };
      if (this.sessionHandle) {
        setup.sessionResumption = { handle: this.sessionHandle, transparent: true };
        console.log(`[gemini-live] 使用 session handle 恢复会话`);
      }
      this.ws!.send(JSON.stringify({ setup }));
    });

    this.ws.on('message', (data: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.goAway) {
        console.log(`[gemini-live] ⚠️ 收到 GoAway，剩余时间: ${msg.goAway.timeLeft || '?'}`);
        return;
      }

      if (msg.sessionResumptionUpdate) {
        const upd = msg.sessionResumptionUpdate;
        if (upd.newHandle) this.sessionHandle = upd.newHandle;
        if (upd.resumable === false && upd.newHandle === undefined) {
          console.log(`[gemini-live] ⚠️ 服务端标记会话不可恢复`);
          this.sessionHandle = null;
        }
        return;
      }

      if (msg.setupComplete) {
        console.log(`[gemini-live] ✅ Setup 完成`);
        return;
      }

      const content = msg.serverContent;
      if (!content) return;

      // 任何 serverContent 都算活动
      if (content.interimInputTranscription) {
        this.lastTextTime = Date.now();
        const t = content.interimInputTranscription.text;
        if (t !== this.lastInterim) {
          this.lastInterim = t;
          this.callbacks.onInterim?.(t);
        }
      }
      if (content.inputTranscription) {
        this.lastTextTime = Date.now();
        const t = content.inputTranscription.text;
        if (t) {
          this.callbacks.onFinal(t);
          this.lastInterim = '';
        }
      }
      // 关键：turnComplete 用于 endStream 通知
      if (content.turnComplete) {
        if (this.resolveEndStream) {
          this.resolveEndStream();
          this.resolveEndStream = null;
          this.endStreamPromise = null;
        }
      }
    });

    this.ws.on('error', (e) => {
      console.error(`[gemini-live] ❌ ${e.message}`);
      this.callbacks.onError?.(e);
    });

    this.ws.on('close', (code) => {
      console.log(`[gemini-live] 连接关闭 code=${code}`);
      if (this.shuttingDown) return;
      if (this.reconnecting) return;
      this.reconnecting = true;
      this.callbacks.onReconnect?.(`close code=${code}`);
      setTimeout(() => this.connect(`重连 (上次 code=${code})`), 2000);
    });
  }

  feed(pcm: Buffer): void {
    this.lastPcmTime = Date.now();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pending = Buffer.concat([this.pending, pcm]);
    while (this.pending.length >= CHUNK_SIZE) {
      const piece = this.pending.subarray(0, CHUNK_SIZE);
      this.pending = this.pending.subarray(CHUNK_SIZE);
      try {
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: { data: piece.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
          },
        }));
      } catch {}
    }
  }

  async endStream(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    if (this.endStreamPromise) return this.endStreamPromise;

    this.endStreamPromise = new Promise<void>((resolve) => {
      this.resolveEndStream = resolve;
    });

    console.log('[gemini-live] 发送 audioStreamEnd，等待最终 transcription...');
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {
      return Promise.resolve();
    }

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.resolveEndStream) {
          console.log('[gemini-live] 等待最终 transcription 超时（5s），继续');
          this.resolveEndStream();
          this.resolveEndStream = null;
          this.endStreamPromise = null;
        }
      }, 5000);
    });

    return Promise.race([this.endStreamPromise, timeout]);
  }

  getLastInterim(): string {
    return this.lastInterim;
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
  }
}
