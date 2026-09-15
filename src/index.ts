import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getLiveInfo } from './douyin/index.js';
import { Anchor, AnchorState, LiveInfo } from './douyin/types.js';
import { Recorder } from './recorder/recorder.js';
import { StreamRecorder } from './recorder/stream-recorder.js';
import { logger } from './logger.js';
import { checkAnchorVideos, VideoProcessResult } from './video/index.js';

// ========== 配置 ==========
const CHECK_INTERVAL_MS = 30_000;
const OFFLINE_THRESHOLD = 3;
const STREAM_FAIL_LIMIT = 5;
const RECORDS_DIR = path.join(process.cwd(), 'records');

const ASR_MODE = process.env.ASR_MODE || 'segment';
const SEGMENT_MINUTES = Number(process.env.SEGMENT_MINUTES || '2');
const SEGMENT_SECONDS = Math.max(30, SEGMENT_MINUTES * 60);
const STREAM_FLUSH_MINUTES = Number(process.env.STREAM_FLUSH_MINUTES || process.env.SEGMENT_MINUTES || '4');
const AI_SUMMARY_EVERY = Math.max(1, Number(process.env.AI_SUMMARY_EVERY || '4'));
const VIDEO_CHECK_MINUTES = Math.max(1, Number(process.env.VIDEO_CHECK_MINUTES || '5'));

// ========== 状态 ==========
interface AnchorRuntime {
  anchor: Anchor;
  state: AnchorState;
  offlineCount: number;
  streamFailCount: number;
  currentRoomId: string | null;
  recorder: Recorder | null;
  streamRecorder: StreamRecorder | null;
}

const runtimes = new Map<string, AnchorRuntime>();
const segmentCounters = new Map<string, number>();

// ========== 微信 ==========
let wxClient: any = null;
let wxCred: any = null;
const WECHAT_CRED_FILE = path.join(process.cwd(), '.wechat-cred.json');
const OUTBOX_FILE = path.join(process.cwd(), 'outbox.jsonl');

async function initWechat(): Promise<void> {
  try {
    const { loginWithQR, WxLinkClient } = await import('wx-link');
    const qrcode = (await import('qrcode-terminal')).default;

    if (fs.existsSync(WECHAT_CRED_FILE)) {
      wxCred = JSON.parse(fs.readFileSync(WECHAT_CRED_FILE, 'utf-8'));
      logger.sys('[wechat] 使用已保存凭证，直接监听');
    } else {
      logger.sys('[wechat] 未配置，请扫码登录');
      const login: any = await loginWithQR({
        onQRCode: (url: string) => {
          console.log('\n=== 请用微信扫码 ===\n');
          qrcode.generate(url, { small: true }, (qr: string) => console.log(qr));
          console.log(`\n(扫码不便时可手动打开: ${url})\n====================\n`);
        },
      });
      wxCred = { baseUrl: login.baseUrl, botToken: login.botToken, cursor: '' };
      fs.writeFileSync(WECHAT_CRED_FILE, JSON.stringify(wxCred, null, 2), { mode: 0o600 });
      logger.sys('[wechat] 登录成功，凭证已保存');
    }

    wxClient = new WxLinkClient({ baseUrl: wxCred.baseUrl, token: wxCred.botToken });

    setInterval(async () => {
      if (!wxClient || !wxCred) return;
      try {
        const updates: any = await wxClient.poll(wxCred.cursor);
        wxCred.cursor = updates.nextCursor ?? wxCred.cursor;
        for (const msg of updates.msgs ?? []) {
          if (msg.from_user_id && msg.context_token) {
            if (!wxCred.targetUserId) logger.sys(`[wechat] 已捕获目标用户: ${msg.from_user_id}`);
            wxCred.targetUserId = msg.from_user_id;
            wxCred.contextToken = msg.context_token;
            fs.writeFileSync(WECHAT_CRED_FILE, JSON.stringify(wxCred, null, 2));
          }
        }
      } catch (e: any) {
        if (!e.message?.includes('timeout')) logger.error('wechat', `poll: ${e.message}`);
      }
    }, 10_000);

    logger.sys('[wechat] 桥接已启动');
  } catch (e: any) {
    logger.error('wechat', `初始化失败: ${e.message}`);
  }
}

async function pushToWechat(tag: string, anchor: Anchor, fileName: string, timeTag: string, text: string): Promise<void> {
  const entry = JSON.stringify({
    tag,
    anchor: anchor.name,
    file: fileName,
    time: timeTag,
    text: text.replace(/\s+/g, ' ').trim(),
  }) + '\n';
  fs.appendFileSync(OUTBOX_FILE, entry, 'utf-8');

  if (wxClient && wxCred?.targetUserId && wxCred?.contextToken) {
    const msg = `【${tag}】【${anchor.name}】${timeTag}\n${text.slice(0, 1500)}`;
    try {
      await wxClient.sendText({
        toUserId: wxCred.targetUserId,
        text: msg,
        contextToken: wxCred.contextToken,
      });
      logger.info('wechat', `[${tag}] 已推送: ${anchor.name} / ${fileName}`);
    } catch (e: any) {
      logger.error('wechat', `[${tag}] 推送失败: ${e.message}`);
    }
  }
}

// ========== 工具 ==========
function loadAnchors(): Anchor[] {
  const p = path.join(process.cwd(), 'config', 'anchors.json');
  if (!fs.existsSync(p)) throw new Error(`找不到配置文件: ${p}`);
  const list = JSON.parse(fs.readFileSync(p, 'utf-8')) as Anchor[];
  return list.filter(a => a.enabled);
}

function formatBeijingTime(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ` +
         `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}

function findLatestTranscript(anchorName: string): string | null {
  const anchorDir = path.join(RECORDS_DIR, anchorName, 'live');
  if (!fs.existsSync(anchorDir)) return null;
  const dirs = fs.readdirSync(anchorDir).filter(d => /^\d{12}$/.test(d)).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const p = path.join(anchorDir, dirs[i], 'transcript.txt');
    if (fs.existsSync(p)) return p;
    const p2 = path.join(anchorDir, dirs[i], 'live_transcript.txt');
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

// ========== 直播结束总结 ==========
async function generateAndPushSummary(anchor: Anchor): Promise<void> {
  const transcriptPath = findLatestTranscript(anchor.name);
  if (!transcriptPath) {
    logger.warn(anchor.name, '[LIVE] 未找到 transcript，跳过总结');
    return;
  }
  const fullText = fs.readFileSync(transcriptPath, 'utf-8');
  if (fullText.length < 100) {
    logger.warn(anchor.name, '[LIVE] 文本太短，跳过总结');
    return;
  }

  logger.info(anchor.name, `[LIVE] 生成直播总结中 (${fullText.length} 字)...`);
  const t0 = Date.now();
  let summary = '';
  try {
    logger.info(anchor.name, '[LIVE] [ai] 调用 gemini (直播总结)');
    const { summarizeSession } = await import('./ai/gemini.js');
    summary = await summarizeSession(fullText);
  } catch (e: any) {
    logger.warn(anchor.name, `[LIVE] Gemini 失败，降级到腾讯: ${e.message}`);
    try {
      const { summarizeSession } = await import('./ai/tencent.js');
      summary = await summarizeSession(fullText);
    } catch (e2: any) {
      logger.error(anchor.name, `[LIVE] 所有 AI 都失败: ${e2.message}`);
      return;
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const summaryPath = path.join(path.dirname(transcriptPath), 'summary.md');
  fs.writeFileSync(summaryPath, summary, 'utf-8');
  logger.info(anchor.name, `[LIVE] 总结完成 (${dt}s) -> ${summaryPath}`);

  const timeTag = formatBeijingTime(new Date());
  await pushToWechat('LIVE', anchor, 'summary.md', timeTag, `【直播总结】\n${summary.slice(0, 1500)}`);
}

// ========== 切片模式：onSegmentReady ==========
async function onSegmentReady(anchor: Anchor, segmentPath: string, hourDir: string): Promise<void> {
  const name = path.basename(segmentPath);
  logger.info(anchor.name, `[LIVE] ASR start: ${name}`);
  const t0 = Date.now();
  try {
    const rawText = await (await import('./asr/sensevoice-server.js')).transcribe(segmentPath);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (!rawText) {
      logger.warn(anchor.name, `[LIVE] ASR 空结果: ${name}`);
      return;
    }

    const timeTag = formatBeijingTime(new Date());
    const transcriptPath = path.join(hourDir, 'transcript.txt');
    fs.appendFileSync(transcriptPath, `[${timeTag}] [${name}] ${rawText.replace(/\s+/g, ' ').trim()}\n`, 'utf-8');

    const cnt = (segmentCounters.get(anchor.name) || 0) + 1;
    segmentCounters.set(anchor.name, cnt);
    if (cnt % AI_SUMMARY_EVERY !== 0) {
      logger.info(anchor.name, `[LIVE] ASR done (${dt}s) -> transcript.txt (跳过 AI 总结, ${cnt}/${AI_SUMMARY_EVERY})`);
      return;
    }

    let text = rawText;
    try {
      const { summarizeSegment } = await import('./ai/gemini.js');
      text = await summarizeSegment(rawText);
    } catch (e: any) {
      logger.warn(anchor.name, `[LIVE] Gemini 失败，降级到腾讯: ${e.message}`);
      try {
        const { summarizeSegment } = await import('./ai/tencent.js');
        text = await summarizeSegment(rawText);
      } catch (e2: any) {
        logger.error(anchor.name, `[LIVE] 所有 AI 都失败: ${e2.message}`);
      }
    }
    const summaryPath = path.join(hourDir, 'summary.txt');
    fs.appendFileSync(summaryPath, `\n## ${timeTag} (${name})\n${text}\n`, 'utf-8');
    logger.info(anchor.name, `[LIVE] summary done (${dt}s) -> summary.txt`);

    await pushToWechat('LIVE', anchor, name, timeTag, text);
  } catch (err: any) {
    logger.error(anchor.name, `[LIVE] ASR 失败: ${name} - ${err.message}`);
  }
}

// ========== 流式模式：onStreamFlush ==========
async function onStreamFlush(anchor: Anchor, text: string, hourDir: string): Promise<void> {
  if (!text.trim()) return;

  const t0 = Date.now();
  let summary = text;
  try {
    logger.info(anchor.name, '[LIVE] [ai] 调用 gemini (stream)');
    const { summarizeSegment } = await import('./ai/gemini.js');
    summary = await summarizeSegment(text);
  } catch (e: any) {
    logger.warn(anchor.name, `[LIVE] Gemini 失败，降级到腾讯: ${e.message}`);
    try {
      const { summarizeSegment } = await import('./ai/tencent.js');
      summary = await summarizeSegment(text);
    } catch (e2: any) {
      logger.error(anchor.name, `[LIVE] 所有 AI 都失败，用原始: ${e2.message}`);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info(anchor.name, `[LIVE] summary done (${dt}s) -> summary.txt`);

  const summaryPath = path.join(hourDir, 'summary.txt');
  const timeTag = formatBeijingTime(new Date());
  fs.appendFileSync(summaryPath, `\n## ${timeTag}\n${summary}\n`, 'utf-8');

  await pushToWechat('LIVE', anchor, 'stream', timeTag, summary);
}

// ========== 主循环 tick ==========
async function tick(rt: AnchorRuntime): Promise<void> {
  const { anchor } = rt;

  // 无 webRid 则不监控直播
  if (!anchor.webRid) {
    return;
  }

  // 注意：这里不再改 state 为 CHECKING
  // 否则 OFFLINE 分支检查 state === RECORDING 会永远失败
  // 状态只在明确开播/录制时改

  let live: LiveInfo;
  try {
    live = await getLiveInfo(anchor);
  } catch (err: any) {
    rt.state = AnchorState.ERROR;
    logger.error(anchor.name, `[LIVE] 检查直播状态失败: ${err.message}`);
    return;
  }

  if (!live.isLive) {
    rt.offlineCount = Math.min(rt.offlineCount + 1, OFFLINE_THRESHOLD + 1);
    logger.info(anchor.name, `[LIVE] OFFLINE (${rt.offlineCount}/${OFFLINE_THRESHOLD}) state=${rt.state}`);

    if (rt.state === AnchorState.RECORDING && rt.offlineCount >= OFFLINE_THRESHOLD) {
      logger.info(anchor.name, `[LIVE] LIVE ended (state=${rt.state}, offline=${rt.offlineCount})`);
      rt.recorder?.stop(anchor.name);
      rt.streamRecorder?.stop(anchor.name);
      rt.state = AnchorState.OFFLINE;
      rt.currentRoomId = null;
      rt.streamFailCount = 0;
      rt.offlineCount = 0;
      generateAndPushSummary(anchor).catch((e: any) => {
        logger.error(anchor.name, `[LIVE] 生成总结失败: ${e.message}`);
      });
    }
    // 注意：不提前改成 OFFLINE，保持 RECORDING 状态，等 offlineCount 到 3 触发 LIVE ended
    return;
  }

  rt.offlineCount = 0;
  rt.state = AnchorState.LIVE;
  rt.currentRoomId = live.roomId;

  const isRec = ASR_MODE === 'stream'
    ? rt.streamRecorder?.isRecording()
    : rt.recorder?.isRecording();
  if (isRec) {
    logger.info(anchor.name, `[LIVE] LIVE (recording, room_id=${live.roomId})`);
    return;
  }

  rt.state = AnchorState.RESOLVING_STREAM;
  logger.info(anchor.name, `[LIVE] LIVE, room_id=${live.roomId}`);
  logger.info(anchor.name, `[LIVE] resolving stream...`);

  if (!live.streamUrl) {
    rt.streamFailCount++;
    logger.error(anchor.name, `[LIVE] stream URL 为空 (${rt.streamFailCount}/${STREAM_FAIL_LIMIT})`);
    if (rt.streamFailCount >= STREAM_FAIL_LIMIT) {
      rt.state = AnchorState.ERROR;
      rt.streamFailCount = 0;
    }
    return;
  }

  rt.streamFailCount = 0;
  logger.info(anchor.name, `[LIVE] stream resolved (${live.streamFormat})`);

  try {
    rt.state = AnchorState.RECORDING;
    if (ASR_MODE === 'stream') {
      rt.streamRecorder?.start(anchor, live);
    } else {
      rt.recorder?.start(anchor, live);
    }
    logger.info(anchor.name, '[LIVE] recording started');
  } catch (err: any) {
    rt.state = AnchorState.ERROR;
    logger.error(anchor.name, `[LIVE] 启动录音失败: ${err.message}`);
  }
}

// ========== 视频处理回调 ==========
async function onVideoProcessed(result: VideoProcessResult): Promise<void> {
  try {
    const timeTag = result.publishTime;
    // 追加到 summary.txt
    const summaryPath = path.join(result.videoDir, 'summary.txt');
    fs.appendFileSync(summaryPath, `\n## ${timeTag} [VIDEO] ${result.videoId}\n${result.summary}\n`, 'utf-8');
    // 推送
    await pushToWechat('VIDEO', result.anchor, result.videoId, timeTag, result.summary);
  } catch (e: any) {
    logger.error(result.anchor.name, `[VIDEO] onProcessed 失败: ${e.message}`);
  }
}

// ========== 初始化 ==========
async function main(): Promise<void> {
  logger.sys('=== 抖音直播 + 视频监控启动 ===');
  logger.sys(`ASR 模式: ${ASR_MODE}`);
  logger.sys(`直播检查间隔: ${CHECK_INTERVAL_MS / 1000}s`);
  logger.sys(`视频检查间隔: ${VIDEO_CHECK_MINUTES}min`);

  await initWechat();

  const anchors = loadAnchors();
  if (anchors.length === 0) { logger.sys('没有启用的主播'); process.exit(1); }
  logger.sys(`已加载 ${anchors.length} 个主播: ${anchors.map(a => a.name).join(', ')}`);

  for (const a of anchors) {
    const rt: AnchorRuntime = {
      anchor: a,
      state: AnchorState.OFFLINE,
      offlineCount: 0,
      streamFailCount: 0,
      currentRoomId: null,
      recorder: null,
      streamRecorder: null,
    };

    rt.recorder = new Recorder({
      recordsDir: RECORDS_DIR,
      segmentSeconds: SEGMENT_SECONDS,
      onSegmentReady: (anchor, segmentPath, hourDir) => {
        processAsrQueue({ anchor, segmentPath, hourDir });
      },
      onExit: (anchor, code) => {
        if (code !== 0 && code !== null) {
          logger.warn(anchor.name, `[LIVE] 切片 ffmpeg 退出 code=${code}`);
        }
      },
    });

    rt.streamRecorder = new StreamRecorder({
      recordsDir: RECORDS_DIR,
      flushSeconds: STREAM_FLUSH_MINUTES * 60,
      onFlush: onStreamFlush,
      onExit: (anchor, code) => {
        if (code !== 0 && code !== null) {
          logger.warn(anchor.name, `[LIVE] 流式 ffmpeg 退出 code=${code}`);
        }
      },
    });

    runtimes.set(a.name, rt);
  }

  // 直播检查：每 30 秒
  const tickAll = async () => {
    for (const rt of runtimes.values()) {
      try { await tick(rt); }
      catch (e: any) { logger.error(rt.anchor.name, `tick 异常: ${e.message}`); }
    }
  };
  await tickAll();
  setInterval(tickAll, CHECK_INTERVAL_MS);

  // 视频检查：每 N 分钟
  const checkAllVideos = async () => {
    for (const rt of runtimes.values()) {
      try {
        await checkAnchorVideos(rt.anchor, onVideoProcessed);
      } catch (e: any) {
        logger.error(rt.anchor.name, `[VIDEO] 检查异常: ${e.message}`);
      }
    }
  };
  setTimeout(() => {
    checkAllVideos();
    setInterval(checkAllVideos, VIDEO_CHECK_MINUTES * 60 * 1000);
  }, 30_000);

  const shutdown = (sig: string) => {
    logger.sys(`收到 ${sig}，清理中...`);
    for (const rt of runtimes.values()) {
      rt.recorder?.stop(rt.anchor.name);
      rt.streamRecorder?.stop(rt.anchor.name);
    }
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ========== ASR 队列（切片模式） ==========
const asrQueue: Array<{ anchor: Anchor; segmentPath: string; hourDir: string }> = [];
let asrRunning = false;

async function processAsrQueue(job: { anchor: Anchor; segmentPath: string; hourDir: string }): Promise<void> {
  asrQueue.push(job);
  if (asrRunning) return;
  asrRunning = true;
  while (asrQueue.length > 0) {
    if (asrQueue.length > 5) {
      const dropped = asrQueue.splice(0, asrQueue.length - 2);
      logger.warn('system', `ASR 积压，丢弃 ${dropped.length} 个切片`);
    }
    const j = asrQueue.shift()!;
    try {
      await onSegmentReady(j.anchor, j.segmentPath, j.hourDir);
    } catch (e: any) {
      logger.error(j.anchor.name, `ASR 队列任务失败: ${e.message}`);
    }
  }
  asrRunning = false;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
