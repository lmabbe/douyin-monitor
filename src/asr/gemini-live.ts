import 'dotenv/config';
import WebSocket from 'ws';

const API_KEY = process.env.GEMINI_API_KEY!;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const CHUNK_SIZE = 3200;   // 100ms 16kHz 16bit PCM

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
  private sessionHandle: string | null = null;   // session_resumption 句柄
  private reconnecting = false;

  constructor(private callbacks: GeminiLiveCallbacks) {}

  start(): void {
    this.connect('initial');
  }

  private connect(reason: string): void {
    if (this.shuttingDown) return;
    console.log(`[gemini-live] 连接... (${reason})`);
    this.ws = new WebSocket(WS_URL);
    this.pending = Buffer.alloc(0);
    this.lastInterim = '';
    this.reconnecting = false;

    this.ws.on('open', () => {
      console.log(`[gemini-live] ✅ 已连接`);
      const setup: any = {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [], mode: 'SMART' },
      };

      // 关键：如果是重连，带上上次的 session 句柄，恢复上下文
      if (this.sessionHandle) {
        setup.sessionResumption = {
          handle: this.sessionHandle,
          transparent: true,
        };
        console.log(`[gemini-live] 使用 session handle 恢复会话`);
      }

      this.ws!.send(JSON.stringify({ setup }));
    });

    this.ws.on('message', (data: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // ========== GoAway：服务端通知即将断开 ==========
      if (msg.goAway) {
        const timeLeft = msg.goAway.timeLeft || '?';
        console.log(`[gemini-live] ⚠️ 收到 GoAway，剩余时间: ${timeLeft}`);
        // 不立即关闭，等 close 事件触发重连
        return;
      }

      // ========== sessionResumptionUpdate：服务端下发新句柄 ==========
      if (msg.sessionResumptionUpdate) {
        const upd = msg.sessionResumptionUpdate;
        if (upd.newHandle) {
          this.sessionHandle = upd.newHandle;
        }
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

      if (content.interimInputTranscription) {
        const t = content.interimInputTranscription.text;
        if (t !== this.lastInterim) {
          this.lastInterim = t;
          this.callbacks.onInterim?.(t);
        }
      }
      if (content.inputTranscription) {
        const t = content.inputTranscription.text;
        if (t) {
          this.callbacks.onFinal(t);
          this.lastInterim = '';
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

      // 短暂延迟后重连
      setTimeout(() => this.connect(`重连 (上次 code=${code})`), 2000);
    });
  }

  feed(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pending = Buffer.concat([this.pending, pcm]);
    while (this.pending.length >= CHUNK_SIZE) {
      const piece = this.pending.subarray(0, CHUNK_SIZE);
      this.pending = this.pending.subarray(CHUNK_SIZE);
      this.ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: piece.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }));
    }
  }

  async endStream(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }

    // 已有等待中的 promise，直接返回（避免重复调用泄漏）
    if (this.endStreamPromise) {
      return this.endStreamPromise;
    }

    this.endStreamPromise = new Promise<void>((resolve) => {
      this.resolveEndStream = resolve;
    });

    console.log('[gemini-live] 发送 audioStreamEnd，等待最终 transcription...');
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));

    // 5 秒超时兜底
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }
}
