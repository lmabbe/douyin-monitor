import {spawn, ChildProcess} from 'child_process';
import path from 'path';
import fs from 'fs';
import {Anchor, LiveInfo} from '../douyin/types.js';
import {logger} from '../logger.js';
import {GeminiLiveTranscriber} from '../asr/gemini-live.js';

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
    private lastOnFinalTime = 0;

    constructor(private opts: StreamRecorderOptions) {
    }

    isRecording(): boolean {
        return this.recording;
    }

    start(anchor: Anchor, liveInfo: LiveInfo): void {
        if (this.recording) {
            logger.warn(anchor.name, '已在流式录音中');
            return;
        }
        if (!liveInfo.streamUrl) throw new Error('streamUrl 为空');

        const dir = this.dirPath(anchor.name);
        fs.mkdirSync(dir, {recursive: true});
        this.currentDir = dir;
        this.lastAnchor = anchor;
        this.buffer = [];
        this.lastOnFinalTime = Date.now();

        logger.info(anchor.name, `流式录音启动 (${liveInfo.streamFormat})`);
        logger.info(anchor.name, `目录: ${dir}`);
        logger.info(anchor.name, `落盘间隔: ${this.opts.flushSeconds} 秒`);

        this.gemini = new GeminiLiveTranscriber({
            onFinal: (text) => {
                this.lastOnFinalTime = Date.now();
                this.buffer.push(text);
                logger.info(anchor.name, `[ONFINAL] ${text.length}字 buffer=${this.buffer.length}`);
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
            ], {stdio: ['ignore', 'pipe', 'pipe']});

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

    async stop(anchorName: string): Promise<void> {
        logger.info(anchorName, '停止流式录音');

        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        /**
         * 先停止 FFmpeg。
         *
         * 防止下播以后继续产生新的 PCM。
         */
        if (this.ffmpeg) {
            try {
                this.ffmpeg.kill('SIGINT');
            } catch {
                // ignore
            }

            this.ffmpeg = null;
        }

        /**
         * 关键：
         *
         * 不要先落盘。
         *
         * 必须先告诉 Gemini：
         *
         * audioStreamEnd
         *
         * 然后等待最后 transcription。
         */
        if (this.gemini) {
            try {
                await this.gemini.endStream();
            } catch (e: any) {
                logger.error(
                    anchorName,
                    `[stop] Gemini endStream 失败: ${e.message}`
                );
            }
        }

        /**
         * 现在 Gemini 最后的 final transcription
         * 已经有机会进入 this.buffer。
         *
         * 再落盘。
         */
        if (this.lastAnchor && this.currentDir) {
            try {
                const interim = this.gemini?.getLastInterim?.();

                if (interim && interim.trim()) {
                    this.buffer.push(interim);
                }

                if (this.buffer.length > 0) {
                    const text = this.buffer.join('');

                    this.buffer = [];

                    const file = path.join(
                        this.currentDir,
                        'live_transcript.txt'
                    );

                    fs.appendFileSync(
                        file,
                        `[${this.timeTag()}] ${text}\n`,
                        'utf-8'
                    );

                    logger.info(
                        anchorName,
                        `[stop] 最后落盘 ${text.length} 字 -> live_transcript.txt`
                    );
                }
            } catch (e: any) {
                logger.error(
                    anchorName,
                    `[stop] 落盘失败: ${e.message}`
                );
            }
        }

        /**
         * 最后再真正关闭 Gemini。
         */
        if (this.gemini) {
            this.gemini.stop();
            this.gemini = null;
        }

        this.recording = false;
    }

    /*async stop(anchorName: string): Promise<void> {
      logger.info(anchorName, `[STOP-DEBUG] 进入 stop，recording=${this.recording}, buffer=${this.buffer.length}, gemini=${!!this.gemini}, ffmpeg=${!!this.ffmpeg}`);
      logger.info(anchorName, '[LIVE] 正在结束录音...');
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }

      if (this.ffmpeg) {
        this.ffmpeg.kill('SIGINT');
        this.ffmpeg = null;
      }

      if (this.gemini) {
        try {
          await this.gemini.endStream();
          logger.info(anchorName, '[ASR] 最终 transcription 已完成');
        } catch (e: any) {
          logger.warn(anchorName, `[ASR] endStream 异常: ${e.message}`);
        }
      }

      if (this.lastAnchor && this.currentDir) {
        try {
          const interim = this.gemini?.getLastInterim?.();
          if (interim && interim.trim()) this.buffer.push(interim);
          if (this.buffer.length > 0) {
            const text = this.buffer.join('');
            this.buffer = [];
            const file = path.join(this.currentDir, 'live_transcript.txt');
            fs.appendFileSync(file, `[${this.timeTag()}] ${text}\n`, 'utf-8');
            logger.info(anchorName, `[LIVE] 最终 transcript 已写入 ${text.length} 字`);
          } else {
            logger.info(anchorName, '[LIVE] buffer 为空，无新文本落盘');
          }
        } catch (e: any) {
          logger.error(anchorName, `[LIVE] flush 失败: ${e.message}`);
        }
      }

      if (this.gemini) {
        try { this.gemini.stop(); } catch {}
        this.gemini = null;
      }

      this.recording = false;
    }*/

    private async flushNow(anchor: Anchor): Promise<void> {
        const idleSec = (Date.now() - this.lastOnFinalTime) / 1000;
        logger.info(anchor.name, `[FLUSH] buffer=${this.buffer.length}, idle=${idleSec.toFixed(0)}s`);

        if (!this.currentDir) return;

        // 如果 buffer 为空（Gemini 断流超过 3 分钟），用已有文件内容触发总结
        if (this.buffer.length === 0) {
            if (idleSec > 180) {
                try {
                    const file = path.join(this.currentDir, 'live_transcript.txt');
                    const existing = fs.readFileSync(file, 'utf-8').trim();
                    if (existing.length > 100) {
                        const recent = existing.split('\n').slice(-30).join('\n');
                        logger.warn(anchor.name, `[FLUSH] buffer 空且已 idle ${idleSec.toFixed(0)}s，用最近文本触发总结`);
                        await this.opts.onFlush(anchor, recent, this.currentDir);
                    }
                } catch {
                }
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

    private dirPath(anchorName: string): string {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const tag = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
        return path.join(this.opts.recordsDir, anchorName, 'live', tag);
    }

    private timeTag(): string {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
}
