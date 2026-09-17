import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Anchor, LiveInfo } from '../douyin/types.js';
import { logger } from '../logger.js';
import { GeminiLiveTranscriber } from '../asr/gemini-live.js';

interface StreamRecorderOptions {
  recordsDir: string;
  flushSeconds: number;
  onFlush: (anchor: Anchor, text: string, hourDir: string) => Promise<void>;
  onExit?: (anchor: Anchor, code: number | null) => void;
}

export class StreamRecorder {
  private ffmpeg: ChildProcess | null = null;
  private gemini: GeminiLiveTranscriber | null = null;
  private recording = false;
  private currentDir: string | null = null;
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private lastOnFinalTime = 0;
  private lastAnchor: Anchor | null = null;

  constructor(private opts: StreamRecorderOptions) {}

  isRecording(): boolean { return this.recording; }

  start(anchor: Anchor, liveInfo: LiveInfo, liveDir: string): void {
    if (this.recording) {
      logger.warn(anchor.name, '已在流式录音中');
      return;
    }
    if (!liveInfo.streamUrl) throw new Error('streamUrl 为空');

    fs.mkdirSync(liveDir, { recursive: true });
    this.currentDir = liveDir;
    this.lastAnchor = anchor;
    this.buffer = [];
    this.lastOnFinalTime = Date.now();

    logger.info(anchor.name, `流式录音启动 (${liveInfo.streamFormat})`);
    logger.info(anchor.name, `目录: ${liveDir}`);
    logger.info(anchor.name, `落盘间隔: ${this.opts.flushSeconds} 秒`);

    this.gemini = new GeminiLiveTranscriber({
      onFinal: (text) => {
        this.lastOnFinalTime = Date.now();
        this.buffer.push(text);
        logger.info(anchor.name, `[ONFINAL][${text}] ${text.length}字 buffer=${this.buffer.length}`);
      },
      onInterim: () => {},
      onError: (e) => logger.error(anchor.name, `Gemini Live: ${e.message}`),
      onReconnect: (reason) => {
        logger.info(anchor.name, `Gemini 重连 (${reason})，缓冲区保留`);
      },
    });
    this.gemini.start();

    setTimeout(() => {
      if (!this.gemini) return;
      logger.info(anchor.name, 'FFmpeg 拉流中...');

      this.ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', liveInfo.streamUrl,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      this.ffmpeg.stderr?.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s && !s.includes('Connection timed out') && !s.includes('End of file')) {
          logger.error(anchor.name, `ffmpeg: ${s}`);
        }
      });

      this.ffmpeg.stdout?.on('data', (chunk: Buffer) => {
        this.gemini?.feed(chunk);
      });

      this.ffmpeg.on('exit', (code) => {
        logger.info(anchor.name, `ffmpeg 退出 code=${code}`);
        this.recording = false;
        this.opts.onExit?.(anchor, code);
      });

      this.recording = true;
    }, 2000);

    this.flushTimer = setInterval(() => {
      this.flushNow(anchor).catch((e) => logger.error(anchor.name, `落盘失败: ${e.message}`));
    }, this.opts.flushSeconds * 1000);
  }

  async stop(anchorName: string): Promise<void> {
    if (!this.recording && !this.gemini) return;   // 没在录就不打日志
    logger.info(anchorName, '停止流式录音');

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 1. 停 FFmpeg，等它真正退出（最多 5 秒）
    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          logger.warn(anchorName, 'stream ffmpeg 未在 5s 内退出，SIGKILL');
          try { proc.kill('SIGKILL'); } catch {}
          finish();
        }, 5000);
        proc.on('exit', () => finish());
        try { proc.kill('SIGINT'); } catch {}
      });
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

  private async flushNow(anchor: Anchor): Promise<void> {
    const idleSec = (Date.now() - this.lastOnFinalTime) / 1000;
    if (!this.currentDir) return;

    if (this.buffer.length === 0) {
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

    const text = this.buffer.join('');
    this.buffer = [];

    const file = path.join(this.currentDir, 'live_transcript.txt');
    fs.appendFileSync(file, `[${this.timeTag()}] ${text}\n`, 'utf-8');
    logger.info(anchor.name, `落盘 ${text.length} 字 -> live_transcript.txt`);

    try {
      await this.opts.onFlush(anchor, text, this.currentDir);
    } catch (e: any) {
      logger.error(anchor.name, `onFlush 失败: ${e.message}`);
    }
  }

  private timeTag(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}