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
  private lastAnchor: Anchor | null = null;

  constructor(private opts: StreamRecorderOptions) {}

  isRecording(): boolean { return this.recording; }

  start(anchor: Anchor, liveInfo: LiveInfo): void {
    if (this.recording) { logger.warn(anchor.name, '已在流式录音中'); return; }
    if (!liveInfo.streamUrl) throw new Error('streamUrl 为空');

    const dir = this.dirPath(anchor.name);
    fs.mkdirSync(dir, { recursive: true });
    this.currentDir = dir;
    this.lastAnchor = anchor;
    this.buffer = [];

    logger.info(anchor.name, `流式录音启动 (${liveInfo.streamFormat})`);
    logger.info(anchor.name, `目录: ${dir}`);
    logger.info(anchor.name, `落盘间隔: ${this.opts.flushSeconds} 秒`);

    this.gemini = new GeminiLiveTranscriber({
      onFinal: (text) => {
        this.buffer.push(text);
        logger.info(anchor.name, `[live] ${text}`);
      },
      onInterim: (text) => {
        process.stdout.write(`\r[${anchor.name}] ${text.slice(-50)}    `);
      },
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
        '-vn', '-ar', '16000', '-ac', '1',
        '-f', 's16le', '-acodec', 'pcm_s16le',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      this.ffmpeg.stderr?.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s && !s.includes('Connection timed out') && !s.includes('End of file')) {
          logger.error(anchor.name, `ffmpeg: ${s}`);
        }
      });
      this.ffmpeg.stdout?.on('data', (chunk: Buffer) => this.gemini?.feed(chunk));
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

  stop(anchorName: string): void {
    logger.info(anchorName, '停止流式录音');
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }

    // 停止前 flush 一次，避免丢最后的文本
    if (this.lastAnchor && this.currentDir) {
      try {
        // 1) 把 Gemini 的 lastInterim（最后的中间结果）也加进 buffer
        const interim = this.gemini?.getLastInterim?.();
        if (interim && interim.trim()) {
          this.buffer.push(interim);
        }
        // 2) 落盘
        if (this.buffer.length > 0) {
          const text = this.buffer.join('');
          this.buffer = [];
          const file = path.join(this.currentDir, 'live_transcript.txt');
          fs.appendFileSync(file, `[${this.timeTag()}] ${text}\n`, 'utf-8');
          logger.info(anchorName, `[stop] 最后落盘 ${text.length} 字（含 interim）-> live_transcript.txt`);
        }
      } catch (e: any) {
        logger.error(anchorName, `[stop] 落盘失败: ${e.message}`);
      }
    }

    if (this.gemini) {
      this.gemini.endStream();
      setTimeout(() => this.gemini?.stop(), 2000);
      this.gemini = null;
    }
    if (this.ffmpeg) { this.ffmpeg.kill('SIGINT'); this.ffmpeg = null; }
    this.recording = false;
  }

  private async flushNow(anchor: Anchor): Promise<void> {
    if (this.buffer.length === 0 || !this.currentDir) return;
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

  private dirPath(anchorName: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const tag = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    return path.join(this.opts.recordsDir, anchorName, 'live', tag);
  }

  private timeTag(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}
