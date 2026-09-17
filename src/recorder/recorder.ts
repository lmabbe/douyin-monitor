import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Anchor, LiveInfo } from '../douyin/types.js';
import { logger } from '../logger.js';

interface RecorderOptions {
  recordsDir: string;
  segmentSeconds?: number;
  onSegmentReady?: (anchor: Anchor, segmentPath: string, hourDir: string) => void;
  onExit?: (anchor: Anchor, code: number | null) => void;
}

export class Recorder {
  private process: ChildProcess | null = null;
  private recording = false;
  private currentHourDir: string | null = null;
  private segmentSeconds: number;
  private recordsDir: string;
  private onSegmentReady?: RecorderOptions['onSegmentReady'];
  private onExit?: RecorderOptions['onExit'];
  private seenSegments = new Set<string>();
  private segmentWatcher: NodeJS.Timeout | null = null;

  constructor(opts: RecorderOptions) {
    this.recordsDir = opts.recordsDir;
    this.segmentSeconds = opts.segmentSeconds ?? 120;
    this.onSegmentReady = opts.onSegmentReady;
    this.onExit = opts.onExit;
  }

  isRecording(): boolean { return this.recording; }

  /**
   * @param liveDir 由 index.ts 决定的目录（records/{主播}/live/{时间}_{roomId}）
   */
  start(anchor: Anchor, liveInfo: LiveInfo, liveDir: string): void {
    if (this.recording) {
      logger.warn(anchor.name, '已在录音中，跳过 start');
      return;
    }
    if (!liveInfo.streamUrl) throw new Error('streamUrl 为空');

    fs.mkdirSync(liveDir, { recursive: true });
    this.currentHourDir = liveDir;

    const outputTemplate = path.join(liveDir, 'seg_%03d.m4a');
    const isHls = liveInfo.streamFormat === 'hls';

    const audioArgs = isHls
      ? ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1']
      : ['-c:a', 'copy'];

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rw_timeout', '15000000',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', liveInfo.streamUrl,
      '-vn',
      ...audioArgs,
      '-f', 'segment',
      '-segment_time', String(this.segmentSeconds),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-movflags', '+faststart+frag_keyframe+empty_moov+default_base_moof',
      outputTemplate,
    ];

    logger.info(anchor.name, `starting ffmpeg (${liveInfo.streamFormat}, ${this.segmentSeconds}s/segment, audio=${isHls ? 'aac' : 'copy'})`);
    logger.info(anchor.name, `output dir: ${liveDir}`);

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = proc;
    this.recording = true;

    proc.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t.includes('Error') || t.includes('error') || t.includes('failed') || t.includes('404')) {
          logger.error(anchor.name, `ffmpeg: ${t}`);
        }
      }
    });

    proc.on('error', (err) => {
      logger.error(anchor.name, `ffmpeg spawn error: ${err.message}`);
      this.recording = false;
      this.process = null;
      this.onExit?.(anchor, null);
    });

    proc.on('exit', (code, signal) => {
      logger.info(anchor.name, `ffmpeg stopped (code=${code}, signal=${signal})`);
      this.flushRemaining(anchor);
      this.recording = false;
      this.process = null;
      this.onExit?.(anchor, code);
    });

    this.segmentWatcher = setInterval(() => this.scanSegments(anchor), 5000);
  }

  async stop(anchorName: string): Promise<void> {
    if (this.segmentWatcher) {
      clearInterval(this.segmentWatcher);
      this.segmentWatcher = null;
    }
    if (!this.process) { this.recording = false; return; }

    logger.info(anchorName, 'stopping ffmpeg');
    const proc = this.process;
    this.process = null;
    this.recording = false;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        logger.warn(anchorName, 'ffmpeg 未在 8s 内退出，SIGKILL');
        try { proc.kill('SIGKILL'); } catch {}
        finish();
      }, 8000);

      proc.on('exit', () => finish());
      try { proc.kill('SIGINT'); } catch {}
    });
  }

  private scanSegments(anchor: Anchor): void {
    const dir = this.currentHourDir;
    if (!dir || !fs.existsSync(dir)) return;

    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return; }

    const segFiles = files.filter(f => /^seg_\d+\.m4a$/.test(f)).sort();

    for (let i = 0; i < segFiles.length; i++) {
      const f = segFiles[i];
      const full = path.join(dir, f);
      if (this.seenSegments.has(full)) continue;

      const hasNext = i < segFiles.length - 1;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }

      if (st.size < 50 * 1024) continue;

      if (hasNext) {
        this.emitSegment(anchor, full, f, dir, st.size);
        continue;
      }

      const ageSec = (Date.now() - st.mtimeMs) / 1000;
      const grace = this.segmentSeconds + 15;
      if (ageSec >= grace) {
        this.emitSegment(anchor, full, f, dir, st.size);
      }
    }
  }

  private flushRemaining(anchor: Anchor): void {
    const dir = this.currentHourDir;
    if (!dir || !fs.existsSync(dir)) return;
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return; }
    const segFiles = files.filter(f => /^seg_\d+\.m4a$/.test(f)).sort();
    for (const f of segFiles) {
      const full = path.join(dir, f);
      if (this.seenSegments.has(full)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size < 10 * 1024) {
        logger.info(anchor.name, `[flushRemaining] 跳过过小切片 ${f} (${st.size} B)`);
        continue;
      }
      this.emitSegment(anchor, full, f, dir, st.size);
    }
  }

  private emitSegment(anchor: Anchor, fullPath: string, fileName: string, hourDir: string, size: number): void {
    this.seenSegments.add(fullPath);
    logger.info(anchor.name, `segment completed: ${fileName} (${(size/1024).toFixed(0)} KB)`);
    try { this.onSegmentReady?.(anchor, fullPath, hourDir); }
    catch (e: any) { logger.error(anchor.name, `onSegmentReady 回调异常: ${e.message}`); }
  }
}