import 'dotenv/config';
import WebSocket from 'ws';

const API_KEY = process.env.GEMINI_API_KEY!;
const MODEL =
  process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live';

const WS_URL =
  `wss://generativelanguage.googleapis.com/ws/` +
  `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

/**
 * 16kHz / 16bit / mono
 *
 * 16000 samples/s
 * × 2 bytes
 * = 32000 bytes/s
 *
 * 3200 bytes = 100ms 音频
 */
const CHUNK_SIZE = 3200;

/**
 * watchdog 每 5 秒检查一次。
 */
const WATCHDOG_INTERVAL_MS = 5000;

/**
 * Setup 完成后，如果持续收到 PCM，
 * 但 60 秒完全没有任何 Gemini server message，
 * 认为连接可能假死。
 */
const WATCHDOG_TIMEOUT_MS = 60000;

/**
 * 重连退避：
 *
 * 2s
 * 4s
 * 8s
 * 16s
 * 30s
 */
const INITIAL_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * 最多保留 2 秒尚未发送的 PCM。
 *
 * 2 秒 × 32000 bytes/s = 64000 bytes
 */
const MAX_PENDING_BYTES = CHUNK_SIZE * 20;

/**
 * 下播时最多等待 Gemini 最后的 transcription。
 */
const END_STREAM_TIMEOUT_MS = 5000;

/**
 * 每次 event loop 最多发送多少个 chunk。
 *
 * 例如 FFmpeg 一次给过来 32KB：
 *
 * 32KB / 3200 = 10 chunks
 *
 * 不会一次性全部灌给 Gemini。
 */
const MAX_SEND_BURST = 3;

export interface GeminiLiveCallbacks {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (err: Error) => void;
  onReconnect?: (reason: string) => void;
}

export class GeminiLiveTranscriber {
  private ws: WebSocket | null = null;

  /**
   * 还没有发送给 Gemini 的 PCM。
   *
   * 注意：
   * 这里仅保存“尚未发送”的音频。
   *
   * 已经发送给旧 session 的数据，
   * 重连时不会重新发送。
   */
  private pending = Buffer.alloc(0);

  private lastInterim = '';

  private shuttingDown = false;

  /**
   * Gemini setup 是否完成。
   *
   * setupComplete 之前不能发送 realtimeInput。
   */
  private setupComplete = false;

  /**
   * 最后一次收到 Gemini server message。
   *
   * 不只是 transcription。
   * 任何 server message 都算连接仍然活跃。
   */
  private lastServerMessageTime = 0;

  /**
   * 是否正在建立连接。
   */
  private connecting = false;

  /**
   * 是否已经进入重连流程。
   */
  private reconnecting = false;

  /**
   * 重连次数。
   */
  private reconnectAttempt = 0;

  /**
   * reconnect timer。
   */
  private reconnectTimer: NodeJS.Timeout | null = null;

  /**
   * watchdog timer。
   */
  private watchdogTimer: NodeJS.Timeout | null = null;

  /**
   * 音频发送 timer。
   *
   * 这里不是固定 100ms 发送。
   *
   * 只用于把发送工作安排到 event loop，
   * 避免 feed() 一次收到几十 KB 后同步暴发。
   */
  private sendTimer: NodeJS.Timeout | null = null;

  /**
   * 防止 sendAvailable() 重入。
   */
  private sending = false;

  /**
   * 连接稳定计时器。
   */
  private healthyTimer: NodeJS.Timeout | null = null;

  /**
   * 下播时是否已经发送 audioStreamEnd。
   */
  private endStreamRequested = false;

  /**
   * 等待最后 transcription。
   */
  private endStreamResolve: (() => void) | null = null;

  /**
   * 防止 endStream() 被重复调用。
   */
  private ending = false;

  constructor(private callbacks: GeminiLiveCallbacks) {}

  // ============================================================
  // Start
  // ============================================================

  start(): void {
    if (this.shuttingDown) {
      return;
    }

    console.log('[gemini-live] 启动');

    /**
     * 这里非常重要。
     *
     * 之前 startWatchdog() 定义了但没有真正启动。
     */
    this.startWatchdog();

    this.connect('initial');
  }

  // ============================================================
  // WebSocket
  // ============================================================

  private connect(reason: string): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.connecting) {
      return;
    }

    this.connecting = true;
    this.reconnecting = false;
    this.setupComplete = false;

    console.log(
      `[gemini-live] 连接... (${reason}) ` +
      `reconnectAttempt=${this.reconnectAttempt}`
    );

    const ws = new WebSocket(WS_URL);

    /**
     * 当前 socket。
     */
    this.ws = ws;

    ws.on('open', () => {
      if (this.shuttingDown) {
        ws.close();
        return;
      }

      this.connecting = false;
      this.setupComplete = false;
      this.lastServerMessageTime = Date.now();

      console.log('[gemini-live] ✅ WebSocket 已连接');

      /**
       * 不使用 sessionResumption。
       *
       * 每次 reconnect 都建立新的 session。
       */
      const setup = {
        setup: {
          model: `models/${MODEL}`,

          generationConfig: {
            responseModalities: ['TEXT'],
          },

          inputAudioTranscription: {
            languageCodes: [],
            mode: 'SMART',
          },
        },
      };

      try {
        ws.send(JSON.stringify(setup));

        console.log(
          '[gemini-live] → setup 已发送'
        );
      } catch (error: any) {
        console.error(
          `[gemini-live] ❌ setup 发送失败: ${error.message}`
        );
      }
    });

    ws.on('message', (data: Buffer) => {
      /**
       * 任何 server message 都说明连接还活着。
       */
      this.lastServerMessageTime = Date.now();

      let msg: any;

      try {
        msg = JSON.parse(data.toString());
      } catch (error) {
        console.warn(
          '[gemini-live] ⚠️ 收到无法解析的 server message'
        );

        return;
      }

      // ========================================================
      // GoAway
      // ========================================================

      if (msg.goAway) {
        const timeLeft =
          msg.goAway.timeLeft ?? '?';

        console.log(
          `[gemini-live] ⚠️ 收到 GoAway，剩余时间: ${timeLeft}`
        );

        /**
         * 不主动立即 close。
         *
         * 等服务端正常关闭。
         *
         * close event 会统一进入 reconnect。
         */
      }

      // ========================================================
      // Setup Complete
      // ========================================================

      if (msg.setupComplete) {
        this.setupComplete = true;

        console.log(
          '[gemini-live] ✅ Setup 完成'
        );

        /**
         * Setup 完成以后，
         * 如果 pending 里已经有音频，
         * 开始发送。
         */
        this.scheduleSend();

        /**
         * 连接稳定一段时间以后，
         * 才重置 reconnectAttempt。
         */
        this.markHealthy();

        return;
      }

      // ========================================================
      // Server Content
      // ========================================================

      const content = msg.serverContent;

      if (!content) {
        return;
      }

      // --------------------------------------------------------
      // Interim transcription
      // --------------------------------------------------------

      if (content.interimInputTranscription) {
        const text =
          content.interimInputTranscription.text ?? '';

        if (
          text &&
          text !== this.lastInterim
        ) {
          this.lastInterim = text;

          this.callbacks.onInterim?.(text);
        }
      }

      // --------------------------------------------------------
      // Final transcription
      // --------------------------------------------------------

      if (content.inputTranscription) {
        const text =
          content.inputTranscription.text ?? '';

        if (text) {
          this.callbacks.onFinal(text);

          this.lastInterim = '';

          /**
           * 下播等待最后 transcription。
           *
           * 收到 final 后结束等待。
           */
          if (this.endStreamRequested) {
            this.resolveEndStream();
          }
        }
      }
    });

    ws.on('error', (error) => {
      console.error(
        `[gemini-live] ❌ WebSocket error: ${error.message}`
      );

      this.callbacks.onError?.(error);
    });

    ws.on('close', (code, reasonBuffer) => {
      const reason =
        reasonBuffer?.toString() || '';

      console.log(
        `[gemini-live] 连接关闭 ` +
        `code=${code}` +
        `${reason ? ` reason=${reason}` : ''}`
      );

      this.connecting = false;
      this.setupComplete = false;

      /**
       * stop() 主动关闭：
       *
       * 不重连。
       */
      if (this.shuttingDown) {
        return;
      }

      /**
       * 如果已经安排过 reconnect，
       * 不重复安排。
       */
      if (this.reconnecting) {
        return;
      }

      this.reconnecting = true;

      this.callbacks.onReconnect?.(
        `close code=${code}` +
        `${reason ? ` reason=${reason}` : ''}`
      );

      this.scheduleReconnect(code);
    });
  }

  // ============================================================
  // PCM input
  // ============================================================

  feed(pcm: Buffer): void {
    if (this.shuttingDown) {
      return;
    }

    if (!pcm || pcm.length === 0) {
      return;
    }

    /**
     * 把 FFmpeg 输出放进待发送队列。
     */
    this.pending = Buffer.concat([
      this.pending,
      pcm,
    ]);

    /**
     * 如果 Gemini 暂时断线，
     * pending 不能无限增长。
     */
    if (
      this.pending.length >
      MAX_PENDING_BYTES
    ) {
      const dropBytes =
        this.pending.length -
        MAX_PENDING_BYTES;

      console.warn(
        `[gemini-live] ⚠️ PCM backlog ` +
        `${this.pending.length} bytes，` +
        `丢弃最老 ${dropBytes} bytes`
      );

      this.pending =
        this.pending.subarray(dropBytes);
    }

    /**
     * 有数据以后安排发送。
     */
    this.scheduleSend();
  }

  // ============================================================
  // PCM send scheduler
  // ============================================================

  private scheduleSend(): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.sendTimer) {
      return;
    }

    /**
     * 下一轮 event loop 再发送。
     *
     * 不用 setInterval(100ms)。
     *
     * 因为 3200 bytes 只是 100ms 音频，
     * 并不意味着 WebSocket 必须严格每 100ms 发一次。
     */
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;

      this.sendAvailable();
    }, 0);
  }

  /**
   * 发送待发送 PCM。
   *
   * 每次 event loop 最多发送 MAX_SEND_BURST 个 chunk。
   */
  private sendAvailable(): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.sending) {
      return;
    }

    const ws = this.ws;

    if (!ws) {
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    /**
     * setup 完成前不能发送 audio。
     */
    if (!this.setupComplete) {
      return;
    }

    if (this.pending.length < CHUNK_SIZE) {
      return;
    }

    this.sending = true;

    try {
      let sent = 0;

      while (
        sent < MAX_SEND_BURST &&
        this.pending.length >= CHUNK_SIZE &&
        ws.readyState === WebSocket.OPEN
      ) {
        const piece =
          this.pending.subarray(
            0,
            CHUNK_SIZE
          );

        try {
          ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data:
                    piece.toString('base64'),

                  mimeType:
                    'audio/pcm;rate=16000',
                },
              },
            })
          );

          /**
           * 只有 send 成功以后，
           * 才从 pending 删除。
           */
          this.pending =
            this.pending.subarray(
              CHUNK_SIZE
            );

          sent++;
        } catch (error: any) {
          console.error(
            `[gemini-live] ❌ PCM send 失败: ` +
            `${error.message}`
          );

          break;
        }
      }
    } finally {
      this.sending = false;
    }

    /**
     * 如果还有数据，
     * 下一轮 event loop 继续。
     */
    if (
      !this.shuttingDown &&
      this.setupComplete &&
      this.pending.length >= CHUNK_SIZE
    ) {
      this.scheduleSend();
    }
  }

  // ============================================================
  // Watchdog
  // ============================================================

  private startWatchdog(): void {
    if (this.watchdogTimer) {
      return;
    }

    this.watchdogTimer = setInterval(() => {
      this.checkHealth();
    }, WATCHDOG_INTERVAL_MS);

    console.log(
      '[gemini-live] watchdog 已启动'
    );
  }

  private checkHealth(): void {
    if (this.shuttingDown) {
      return;
    }

    const ws = this.ws;

    if (!ws) {
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    /**
     * setup 都没完成，
     * 不判断假死。
     */
    if (!this.setupComplete) {
      return;
    }

    /**
     * 没有收到 server message 多久。
     */
    const idleMs =
      Date.now() -
      this.lastServerMessageTime;

    if (
      idleMs <
      WATCHDOG_TIMEOUT_MS
    ) {
      return;
    }

    /**
     * 这里不要简单判断：
     *
     * idle > 60s
     *
     * 因为主播可能真的 60 秒没说话。
     *
     * 必须还有待发送 PCM，
     * 才认为我们确实在持续给 Gemini 喂数据。
     */
    if (this.pending.length === 0) {
      return;
    }

    console.warn(
      `[gemini-live] ⚠️ Gemini 疑似假死：` +
      `${Math.round(idleMs / 1000)}s 无 server message，` +
      `pending=${this.pending.length} bytes`
    );

    this.forceReconnect(
      'watchdog timeout'
    );
  }

  // ============================================================
  // Reconnect
  // ============================================================

  private forceReconnect(
    reason: string
  ): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    this.setupComplete = false;

    this.callbacks.onReconnect?.(
      reason
    );

    console.warn(
      `[gemini-live] ⚠️ 主动重连: ${reason}`
    );

    const ws = this.ws;

    if (
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      try {
        ws.close(
          1000,
          reason
        );
      } catch {
        // ignore
      }
    }

    /**
     * close event 正常情况下会调用 scheduleReconnect。
     *
     * 这里不直接 schedule，
     * 避免重复 reconnect。
     */
  }

  private scheduleReconnect(
    code: number
  ): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt++;

    const delay =
      Math.min(
        INITIAL_RECONNECT_DELAY_MS *
          Math.pow(
            2,
            this.reconnectAttempt - 1
          ),
        MAX_RECONNECT_DELAY_MS
      );

    console.log(
      `[gemini-live] ${delay}ms 后重连 ` +
      `(attempt=${this.reconnectAttempt}, ` +
      `code=${code})`
    );

    this.reconnectTimer =
      setTimeout(() => {
        this.reconnectTimer = null;

        if (this.shuttingDown) {
          return;
        }

        this.connect(
          `重连 attempt=${this.reconnectAttempt}, ` +
          `上次 code=${code}`
        );
      }, delay);
  }

  // ============================================================
  // Healthy connection
  // ============================================================

  private markHealthy(): void {
    if (this.healthyTimer) {
      clearTimeout(
        this.healthyTimer
      );

      this.healthyTimer = null;
    }

    /**
     * SetupComplete 不代表真正稳定。
     *
     * 连续运行 60 秒以后，
     * 才清零 reconnectAttempt。
     */
    this.healthyTimer =
      setTimeout(() => {
        if (this.shuttingDown) {
          return;
        }

        this.reconnectAttempt = 0;

        console.log(
          '[gemini-live] ✅ 连接稳定运行 60s，' +
          'reconnectAttempt 已重置'
        );
      }, 60000);
  }

  // ============================================================
  // Graceful end
  // ============================================================

  async endStream(
    timeoutMs = END_STREAM_TIMEOUT_MS
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    /**
     * 防止重复调用。
     */
    if (this.ending) {
      return;
    }

    this.ending = true;

    try {
      const ws = this.ws;

      if (
        !ws ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      if (!this.setupComplete) {
        console.warn(
          '[gemini-live] ⚠️ endStream 时 setup 尚未完成'
        );

        return;
      }

      /**
       * --------------------------------------------------------
       * 1. 把剩余完整 PCM 发出去
       * --------------------------------------------------------
       */

      const deadline =
        Date.now() + 1000;

      while (
        this.pending.length >= CHUNK_SIZE &&
        Date.now() < deadline
      ) {
        this.sendAvailable();

        if (
          this.pending.length >=
          CHUNK_SIZE
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                10
              )
          );
        }
      }

      /**
       * --------------------------------------------------------
       * 2. 最后不足 3200 bytes 的 PCM
       * --------------------------------------------------------
       *
       * 不能因为不足一个 chunk 就直接丢掉。
       */
      if (
        this.pending.length > 0 &&
        ws.readyState === WebSocket.OPEN
      ) {
        const piece =
          this.pending;

        this.pending =
          Buffer.alloc(0);

        try {
          ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data:
                    piece.toString(
                      'base64'
                    ),

                  mimeType:
                    'audio/pcm;rate=16000',
                },
              },
            })
          );
        } catch (error: any) {
          console.error(
            `[gemini-live] ❌ 最后 PCM 发送失败: ` +
            `${error.message}`
          );
        }
      }

      /**
       * --------------------------------------------------------
       * 3. audioStreamEnd
       * --------------------------------------------------------
       */

      this.endStreamRequested =
        true;

      console.log(
        '[gemini-live] → audioStreamEnd 已发送，' +
        '等待最后 transcription'
      );

      try {
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audioStreamEnd: true,
            },
          })
        );
      } catch (error: any) {
        console.error(
          `[gemini-live] ❌ audioStreamEnd 发送失败: ` +
          `${error.message}`
        );

        return;
      }

      /**
       * --------------------------------------------------------
       * 4. 等最后 transcription
       * --------------------------------------------------------
       */

      await new Promise<void>(
        (resolve) => {
          this.endStreamResolve =
            resolve;

          setTimeout(() => {
            if (
              this.endStreamResolve
            ) {
              console.warn(
                '[gemini-live] ⚠️ 等待最后 transcription 超时'
              );

              this.endStreamResolve =
                null;

              resolve();
            }
          }, timeoutMs);
        }
      );

      console.log(
        '[gemini-live] ✅ endStream 完成'
      );
    } finally {
      this.endStreamRequested =
        false;

      this.ending = false;
    }
  }

  private resolveEndStream(): void {
    if (
      !this.endStreamResolve
    ) {
      return;
    }

    const resolve =
      this.endStreamResolve;

    this.endStreamResolve = null;

    resolve();
  }

  // ============================================================
  // Getters
  // ============================================================

  getLastInterim(): string {
    return this.lastInterim;
  }

  // ============================================================
  // Stop
  // ============================================================

  stop(): void {
    this.shuttingDown = true;

    /**
     * send timer
     */
    if (this.sendTimer) {
      clearTimeout(
        this.sendTimer
      );

      this.sendTimer = null;
    }

    /**
     * watchdog
     */
    if (this.watchdogTimer) {
      clearInterval(
        this.watchdogTimer
      );

      this.watchdogTimer = null;
    }

    /**
     * reconnect
     */
    if (this.reconnectTimer) {
      clearTimeout(
        this.reconnectTimer
      );

      this.reconnectTimer = null;
    }

    /**
     * healthy timer
     */
    if (this.healthyTimer) {
      clearTimeout(
        this.healthyTimer
      );

      this.healthyTimer = null;
    }

    this.connecting = false;
    this.reconnecting = false;
    this.setupComplete = false;

    /**
     * 清理等待 endStream 的 Promise。
     */
    this.endStreamResolve = null;

    const ws = this.ws;

    this.ws = null;

    if (
      ws &&
      (
        ws.readyState ===
          WebSocket.OPEN ||
        ws.readyState ===
          WebSocket.CONNECTING
      )
    ) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    console.log(
      '[gemini-live] 已停止'
    );
  }
}