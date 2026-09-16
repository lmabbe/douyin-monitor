import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Anchor } from '../douyin/types.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

let DOUYIN_COOKIE = '';
const FETCH_COUNT = Number(process.env.VIDEO_FETCH_COUNT || '20');
const RECORDS_DIR = path.join(process.cwd(), 'records');
const STATE_FILE = path.join(process.cwd(), '.video-state.json');

// ========== 状态文件：{ "主播名": "202609151316" } ==========
function loadState(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

function getCookie():string{
  return  process.env.DOUYIN_COOKIE || '';
  /*if (DOUYIN_COOKIE == ''){
    DOUYIN_COOKIE = process.env.DOUYIN_COOKIE || '';
  }
  return DOUYIN_COOKIE || process.env.DOUYIN_COOKIE;*/
}

function saveState(state: Record<string, string>): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function getLastTime(anchorName: string): string | null {
  const state = loadState();
  return state[anchorName] || null;
}

function setLastTime(anchorName: string, tag: string): void {
  const state = loadState();
  state[anchorName] = tag;
  saveState(state);
}

// ========== 时间转换 ==========
/** polydl 的 createTime 是 UTC，-8 小时转北京时间，返回 YYYYMMDDHHmm */
function timeToDirTag(t: string): string {
  if (!t) return 'unknown';
  const m = t.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return 'unknown';
  const utcDate = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  ));
  const bj = new Date(utcDate.getTime() - 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}${p(bj.getUTCMonth() + 1)}${p(bj.getUTCDate())}${p(bj.getUTCHours())}${p(bj.getUTCMinutes())}`;
}

function utcToBeijing(t: string): string {
  if (!t) return t;
  const m = t.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return t;
  const utcDate = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  ));
  const bj = new Date(utcDate.getTime() - 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}

export interface VideoProcessResult {
  anchor: Anchor;
  videoId: string;
  publishTime: string;
  dirTag: string;
  text: string;
  summary: string;
  videoDir: string;
}

export async function checkAnchorVideos(
  anchor: Anchor,
  onProcessed: (result: VideoProcessResult) => Promise<void>
): Promise<void> {
  if (!anchor.videoUrl) {
    logger.info(anchor.name, '[VIDEO] 未配置视频主页，跳过');
    return;
  }
  if (!getCookie()) {
    logger.error(anchor.name, '[VIDEO] 未配置 DOUYIN_COOKIE，跳过');
    return;
  }

  logger.info(anchor.name, '[VIDEO] 检查新视频...');

  try {
    const { getSecUserId, DouyinHandler, DouyinDownloader } = await import('polydl');

    const secUserId = await getSecUserId(anchor.videoUrl);
    const handler = new DouyinHandler({ cookie: getCookie() });

    // 收集所有视频
    const allVideos: Array<{ id: string; createTime: string; dirTag: string }> = [];
    for await (const postFilter of handler.fetchUserPostVideos(secUserId, { maxCounts: FETCH_COUNT })) {
      const list = postFilter.toAwemeDataList();
      for (const a of list) {
        const id = a.awemeId || a.aweme_id;
        if (!id) continue;
        const ct = a.createTime || a.create_time || '';
        allVideos.push({ id, createTime: ct, dirTag: timeToDirTag(ct) });
      }
      if (allVideos.length >= FETCH_COUNT) break;
    }

    // 按时间倒序（最新在前）
    allVideos.sort((a, b) => (b.createTime || '').localeCompare(a.createTime || ''));

    // 拿基准时间
    const lastTime = getLastTime(anchor.name);

    if (!lastTime) {
      // 首次运行：只处理最新 1 条
      if (allVideos.length === 0) {
        logger.info(anchor.name, '[VIDEO] 没有视频');
        return;
      }
      const latest = allVideos[0];
      logger.info(anchor.name, `[VIDEO] 首次运行，只处理最新 1 条 (${latest.dirTag})`);
      await processOne(anchor, handler, secUserId, latest.id, latest.createTime, latest.dirTag, onProcessed);
      setLastTime(anchor.name, latest.dirTag);
      logger.info(anchor.name, `[VIDEO] 基准时间已设为 ${latest.dirTag}`);
      return;
    }

    // 增量：找 dirTag > lastTime 的
    const toProcess = allVideos.filter(v => v.dirTag > lastTime);
    logger.info(anchor.name, `[VIDEO] 基准时间: ${lastTime}，共 ${allVideos.length} 个，新视频 ${toProcess.length} 个`);

    if (toProcess.length === 0) {
      logger.info(anchor.name, '[VIDEO] 没有新视频');
      return;
    }

    // 按时间正序处理（先旧后新）
    toProcess.sort((a, b) => (a.createTime || '').localeCompare(b.createTime || ''));

    for (const target of toProcess) {
      await processOne(anchor, handler, secUserId, target.id, target.createTime, target.dirTag, onProcessed);
    }

    // 更新基准时间为最新的
    const newest = allVideos[0];
    setLastTime(anchor.name, newest.dirTag);
    logger.info(anchor.name, `[VIDEO] 基准时间已更新为 ${newest.dirTag}`);

  } catch (e: any) {
    logger.error(anchor.name, `[VIDEO] 检查失败: ${e.message}`);
  }
}

async function processOne(
  anchor: Anchor,
  handler: any,
  secUserId: string,
  videoId: string,
  createTime: string,
  dirTag: string,
  onProcessed: (result: VideoProcessResult) => Promise<void>,
): Promise<void> {
  logger.info(anchor.name, `[VIDEO] 处理 ${videoId} (${utcToBeijing(createTime)})`);
  try {
    const { DouyinDownloader } = await import('polydl');

    // 找完整 aweme 对象
    let targetAweme: any = null;
    for await (const postFilter of handler.fetchUserPostVideos(secUserId, { maxCounts: FETCH_COUNT })) {
      const list = postFilter.toAwemeDataList();
      for (const a of list) {
        if ((a.awemeId || a.aweme_id) === videoId) { targetAweme = a; break; }
      }
      if (targetAweme) break;
    }
    if (!targetAweme) { logger.error(anchor.name, `[VIDEO] 找不到 ${videoId}`); return; }

    // 目录
    const videoDir = path.join(RECORDS_DIR, anchor.name, 'video', dirTag);
    fs.mkdirSync(videoDir, { recursive: true });

    // 临时目录
    const tmpDir = path.join(RECORDS_DIR, anchor.name, 'video', '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    // 下载
    const downloader = new DouyinDownloader({
      cookie: getCookie(),
      downloadPath: tmpDir,
      naming: '{aweme_id}',
      music: false, cover: false, desc: false,
    });
    await downloader.createDownloadTasks(targetAweme, tmpDir);

    const candidates = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.mp4'));
    if (candidates.length === 0) { logger.error(anchor.name, `[VIDEO] 下载失败 ${videoId}`); return; }
    const videoPath = path.join(tmpDir, candidates[0]);
    logger.info(anchor.name, `[VIDEO] 已下载 ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB`);

    // 提取音频
    const audioPath = path.join(videoDir, `${videoId}.m4a`);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '96k', audioPath,
    ]);
    logger.info(anchor.name, `[VIDEO] 已提取音频`);

    // ASR: Gemini Live 主，本地 SenseVoice 兜底（不请求 3000 远程服务）
    const t0 = Date.now();
    let text = '';
    try {
      const { transcribeFile } = await import('../asr/gemini-live-file.js');
      text = await transcribeFile(audioPath);
      logger.info(anchor.name, `[VIDEO] ASR (Gemini Live) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
    } catch (e: any) {
      logger.warn(anchor.name, `[VIDEO] Gemini Live 失败，降级到本地 SenseVoice: ${e.message}`);
      const { transcribe } = await import('../asr/sensevoice.js');
      text = await transcribe(audioPath);
      logger.info(anchor.name, `[VIDEO] ASR (本地 SenseVoice) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
    }

    fs.writeFileSync(path.join(videoDir, `${videoId}.txt`), text, 'utf-8');

    // AI 总结
    let summary = text;
    try {
      const { summarizeSegment } = await import('../ai/gemini.js');
      summary = await summarizeSegment(text);
    } catch (e: any) {
      logger.warn(anchor.name, `[VIDEO] Gemini 失败，降级到腾讯: ${e.message}`);
      try {
        const { summarizeSegment } = await import('../ai/tencent.js');
        summary = await summarizeSegment(text);
      } catch (e2: any) {
        logger.error(anchor.name, `[VIDEO] 所有 AI 失败: ${e2.message}`);
      }
    }
    fs.writeFileSync(path.join(videoDir, `${videoId}.summary.txt`), summary, 'utf-8');
    logger.info(anchor.name, `[VIDEO] 总结完成 -> ${dirTag}/${videoId}.summary.txt`);

    // 清理临时视频
    fs.unlinkSync(videoPath);

    // 推送
    await onProcessed({
      anchor,
      videoId,
      publishTime: utcToBeijing(createTime),
      dirTag,
      text,
      summary,
      videoDir,
    });

  } catch (e: any) {
    logger.error(anchor.name, `[VIDEO] 处理失败 ${videoId}: ${e.message}`);
  }
}
