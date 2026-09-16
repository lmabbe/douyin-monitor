import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Anchor, LiveInfo } from '../douyin/types.js';
import { logger } from '../logger.js';
import { GeminiLiveTranscriber } from '../asr/gemini-live.js';

// ============================================================
// 配置
// ============================================================

interface StreamRecorderOptions {
  // 录音文件保存根目录（通常是 records/）
  recordsDir: string;

  // 落盘间隔（秒）
  // 每 N 秒把缓冲区文本写入 live_transcript.txt，并触发 AI 总结
  flushSeconds: number;

  // 每次落盘后的回调（AI 总结 + 微信推送）
  onFlush: (anchor: Anchor, text: string, hourDir: string) => Promise<void>;

  // FFmpeg 退出回调
  onExit?: (anchor: Anchor, code: number | null) => void;
}

// ============================================================
// 主类
// ============================================================

export class StreamRecorder {
  // FFmpeg 子进程
  private ffmpeg: ChildProcess | null = null;

  // Gemini Live 转写器
  private gemini: GeminiLiveTranscriber | null = null;

  // 是否正在录制
  private recording = false;

  // 当前小时的目录（records/{主播}/live/{YYYYMMDDHHmm}）
  private currentDir: string | null = null;

  // 文本缓冲区（收到 onFinal 时 push）
  private buffer: string[] = [];

  // 定时落盘 timer
  private flushTimer: NodeJS.Timeout | null = null;

  // 最后一次收到 onFinal 的时间（用于兜底判断）
  private lastOnFinalTime = 0;

  // 当前录制的主播（stop 时用）
  private lastAnchor: Anchor | null = null;

  constructor(private opts: StreamRecorderOptions) {}

  isRecording(): boolean { return this.recording; }

  // ============================================================
  // 启动录制
  // ============================================================

  start(anchor: Anchor, liveInfo: LiveInfo): void {
    if (this.recording) {
      logger.warn(anchor.name, '已在流式录音中');
      return;
    }
    if (!liveInfo.streamUrl) throw new Error('streamUrl 为空');

    // 建立当前小时目录
    const dir = this.dirPath(anchor.name);
    fs.mkdirSync(dir, { recursive: true });
    this.currentDir = dir;
    this.lastAnchor = anchor;
    this.buffer = [];
    this.lastOnFinalTime = Date.now();

    logger.info(anchor.name, `流式录音启动 (${liveInfo.streamFormat})`);
    logger.info(anchor.name, `目录: ${dir}`);
    logger.info(anchor.name, `落盘间隔: ${this.opts.flushSeconds} 秒`);

    // ---------- 创建 Gemini Live 转写器 ----------
    this.gemini = new GeminiLiveTranscriber({
      // 收到最终转写时，加入缓冲区
      onFinal: (text) => {
        this.lastOnFinalTime = Date.now();
        this.buffer.push(text);
        logger.info(anchor.name, `[ONFINAL][${text}] ${text.length}字 buffer=${this.buffer.length}`);
      },

      // 中间结果仅用于实时显示，不写入文件
      onInterim: (text) => {
        //process.stdout.write(`\r[${anchor.name}] ${text.slice(-50)}    `);
      },

      onError: (e) => logger.error(anchor.name, `Gemini Live: ${e.message}`),

      onReconnect: (reason) => {
        logger.info(anchor.name, `Gemini 重连 (${reason})，缓冲区保留`);
      },
    });
    this.gemini.start();

    // ---------- 2 秒后启动 FFmpeg ----------
    // 等 Gemini setup 完成再启动，避免音频发早被丢
    setTimeout(() => {
      if (!this.gemini) return;
      logger.info(anchor.name, 'FFmpeg 拉流中...');

      this.ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', liveInfo.streamUrl,
        '-vn',                       // 不要视频
        '-ar', '16000',              // 采样率 16kHz
        '-ac', '1',                  // 单声道
        '-f', 's16le',               // 输出裸 PCM
        '-acodec', 'pcm_s16le',
        'pipe:1',                    // 输出到 stdout
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      // FFmpeg 错误日志（过滤掉无害的连接超时）
      this.ffmpeg.stderr?.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s && !s.includes('Connection timed out') && !s.includes('End of file')) {
          logger.error(anchor.name, `ffmpeg: ${s}`);
        }
      });

      // FFmpeg 输出的 PCM → Gemini
      this.ffmpeg.stdout?.on('data', (chunk: Buffer) => {
        this.gemini?.feed(chunk);
      });

      // FFmpeg 退出
      this.ffmpeg.on('exit', (code) => {
        logger.info(anchor.name, `ffmpeg 退出 code=${code}`);
        this.recording = false;
        this.opts.onExit?.(anchor, code);
      });

      this.recording = true;
    }, 2000);

    // ---------- 定时落盘 ----------
    this.flushTimer = setInterval(() => {
      this.flushNow(anchor).catch((e) => logger.error(anchor.name, `落盘失败: ${e.message}`));
    }, this.opts.flushSeconds * 1000);
  }

  // ============================================================
  // 停止录制（下播时调用）
  // ============================================================
  // 关键顺序：
  //   1. 停 FFmpeg（不再产生新 PCM）
  //   2. 通知 Gemini 音频结束，等最后一批 transcription
  //   3. 最后一次 flush（此时 buffer 已包含所有最终文本）
  //   4. 关闭 Gemini

  async stop(anchorName: string): Promise<void> {
    logger.info(anchorName, '停止流式录音');

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 1. 停 FFmpeg
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGINT'); } catch {}
      this.ffmpeg = null;
    }

    // 2. 通知 Gemini 音频结束，等最后一批 transcription
    if (this.gemini) {
      try {
        await this.gemini.endStream();
      } catch (e: any) {
        logger.error(anchorName, `Gemini endStream 失败: ${e.message}`);
      }
    }

    // 3. 最后一次 flush
    if (this.lastAnchor && this.currentDir) {
      try {
        // 把最后的中间结果也加进来
        const interim = this.gemini?.getLastInterim?.();
        if (interim && interim.trim()) this.buffer.push(interim);

        if (this.buffer.length > 0) {
          const text = this.buffer.join('');
          this.buffer = [];
          const file = path.join(this.currentDir, 'live_transcript.txt');
          fs.appendFileSync(file, `[${this.timeTag()}] ${text}\n`, 'utf-8');
          logger.info(anchorName, `[stop] 最后落盘 ${text.length} 字 -> live_transcript.txt`);
        }
      } catch (e: any) {
        logger.error(anchorName, `[stop] 落盘失败: ${e.message}`);
      }
    }

    // 4. 关闭 Gemini
    if (this.gemini) {
      try { this.gemini.stop(); } catch {}
      this.gemini = null;
    }

    this.recording = false;
  }

  // ============================================================
  // 定时落盘
  // ============================================================

  private async flushNow(anchor: Anchor): Promise<void> {
    const idleSec = (Date.now() - this.lastOnFinalTime) / 1000;
    if (!this.currentDir) return;

    // ---------- 情况 1：buffer 为空 ----------
    if (this.buffer.length === 0) {
      // 如果超过 3 分钟没有新文本，可能是 Gemini 假死
      // 用已有文件里的最后一段内容兜底触发一次总结
      if (idleSec > 180) {
        try {
          const file = path.join(this.currentDir, 'live_transcript.txt');
          const existing = fs.readFileSync(file, 'utf-8').trim();
          if (existing.length > 100) {
            const recent = existing.split('\n').slice(-30).join('\n');
            logger.warn(anchor.name, `[FLUSH] buffer 空且 idle ${idleSec.toFixed(0)}s，用最近文本触发总结`);
            await this.opts.onFlush(anchor, recent, this.currentDir);
          }
        } catch {}
      }
      return;
    }

    // ---------- 情况 2：有文本，正常落盘 ----------
    const text = this.buffer.join('');
    this.buffer = [];

    // 写入 live_transcript.txt
    const file = path.join(this.currentDir, 'live_transcript.txt');
    fs.appendFileSync(file, `[${this.timeTag()}] ${text}\n`, 'utf-8');
    logger.info(anchor.name, `落盘 ${text.length} 字 -> live_transcript.txt`);

    // 触发 AI 总结 + 微信推送
    try {
      await this.opts.onFlush(anchor, text, this.currentDir);
    } catch (e: any) {
      logger.error(anchor.name, `onFlush 失败: ${e.message}`);
    }
  }

  // ============================================================
  // 目录 & 时间戳
  // ============================================================

  // 每小时目录：records/{主播}/live/{YYYYMMDDHHmm}
  private dirPath(anchorName: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const tag = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    return path.join(this.opts.recordsDir, anchorName, 'live', tag);
  }

  // 北京时间字符串：YYYY-MM-DD HH:mm:ss
  private timeTag(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}
