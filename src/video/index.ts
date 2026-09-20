import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {createRequire} from 'module';
import {fileURLToPath} from 'url';
import {Anchor} from '../douyin/types.js';
import {logger} from '../logger.js';
import {summarizeSegment} from '../ai'

const require = createRequire(import.meta.url);
const {signUrl} = require('./signer/signer.cjs') as { signUrl: (params: string, api?: string) => string };

const execFileAsync = promisify(execFile);

// 用 import.meta.url 定位项目根，避免依赖 process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const FETCH_COUNT = Number(process.env.VIDEO_FETCH_COUNT || '20');
const RECORDS_DIR = path.join(ROOT, 'records');
const STATE_FILE = path.join(ROOT, '.video-state.json');
const WEBSIGN_ENV = path.join(ROOT, 'config', 'websign_env.json');

// ASR 模式：VIDEO_ASR_MODE 优先，没配（或空）就跟随 ASR_MODE
const ASR_MODE = process.env.ASR_MODE || 'segment';
const VIDEO_ASR_MODE = process.env.VIDEO_ASR_MODE || ASR_MODE;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ========== 启动时打印配置 ==========
logger.sys(`[VIDEO] ROOT = ${ROOT}`);
logger.sys(`[VIDEO] RECORDS_DIR = ${RECORDS_DIR}`);
logger.sys(`[VIDEO] STATE_FILE = ${STATE_FILE}`);
logger.sys(`[VIDEO] WEBSIGN_ENV = ${WEBSIGN_ENV}`);
logger.sys(`[VIDEO] FETCH_COUNT = ${FETCH_COUNT}`);
logger.sys(`[VIDEO] WEBSIGN_ENV 存在 = ${fs.existsSync(WEBSIGN_ENV)}`);
logger.sys(`[VIDEO] ASR_MODE(全局) = ${ASR_MODE}, VIDEO_ASR_MODE(视频) = ${VIDEO_ASR_MODE}`);

// ========== 时间转换（create_time 秒级 UTC → 北京时间） ==========
/**
 * create_time（秒级 Unix UTC）→ 北京时间 "YYYY-MM-DD HH:mm:ss"
 */
function tsToBeijing(ts: number): string {
    const d = new Date((ts + 8 * 3600) * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * create_time（秒级 Unix UTC）→ 北京时间目录名 / 排序 key "YYYYMMDDHHmm"
 */
function tsToDirTag(ts: number): string {
    const d = new Date((ts + 8 * 3600) * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// ========== 状态文件 ==========
function loadState(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function saveState(state: Record<string, string>): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ========== Cookie（统一从 config/websign_env.json 读，和签名保持一致） ==========
function getCookie(): string {
    if (process.env.DOUYIN_COOKIE) {
        logger.info('system', `[VIDEO] cookie 来源: .env (DOUYIN_COOKIE), 长度=${process.env.DOUYIN_COOKIE.length}`);
        return process.env.DOUYIN_COOKIE;
    }
    try {
        const env = JSON.parse(fs.readFileSync(WEBSIGN_ENV, 'utf-8'));
        const c = env.cookie || '';
        logger.info('system', `[VIDEO] cookie 来源: config/websign_env.json, 长度=${c.length}`);
        return c;
    } catch (e: any) {
        logger.warn('system', `[VIDEO] 读取 config/websign_env.json 失败: ${e.message}`);
        return '';
    }
}

function getLastTime(anchorName: string): string | null {
    const state = loadState();
    const t = state[anchorName] || null;
    logger.info('system', `[VIDEO] 基准时间 [${anchorName}] = ${t || '(首次运行，无基准)'}`);
    return t;
}

function setLastTime(anchorName: string, tag: string): void {
    const state = loadState();
    state[anchorName] = tag;
    saveState(state);
    logger.info('system', `[VIDEO] 基准时间已更新 [${anchorName}] = ${tag}`);
}

export interface VideoProcessResult {
    anchor: Anchor;
    videoId: string;
    publishTime: string;   // 北京时间 "YYYY-MM-DD HH:mm:ss"
    dirTag: string;        // 北京时间 "YYYYMMDDHHmm"
    text: string;
    summary: string;
    videoDir: string;
}

interface VideoMeta {
    id: string;
    createTime: number;   // 秒级 UTC
    dirTag: string;       // 北京时间 YYYYMMDDHHmm
    aweme: any;
}

// ========== 主流程 ==========
export async function checkAnchorVideos(
    anchor: Anchor,
    onProcessed: (result: VideoProcessResult) => Promise<void>
): Promise<void> {
    logger.info(anchor.name, `[VIDEO] ===== 开始检查 =====`);
    logger.info(anchor.name, `[VIDEO] videoUrl = ${anchor.videoUrl || '(空)'}`);

    if (!anchor.videoUrl) {
        logger.info(anchor.name, '[VIDEO] 未配置视频主页，跳过');
        return;
    }
    const cookie = getCookie();
    logger.info(anchor.name, `[VIDEO] cookie 长度 = ${cookie.length}`);
    if (!cookie) {
        logger.error(anchor.name, '[VIDEO] cookie 为空，跳过');
        return;
    }

    try {
        const secUserId = extractSecUserId(anchor.videoUrl);
        logger.info(anchor.name, `[VIDEO] sec_user_id = ${secUserId || '(提取失败)'}`);
        if (!secUserId) {
            logger.error(anchor.name, `[VIDEO] 无法从 URL 提取 sec_user_id: ${anchor.videoUrl}`);
            return;
        }

        const allVideos = await fetchPostList(secUserId, cookie);
        logger.info(anchor.name, `[VIDEO] 拉到 ${allVideos.length} 个视频`);

        // 按 createTime 数值降序（最新在前）
        allVideos.sort((a, b) => b.createTime - a.createTime);

        if (allVideos.length > 0) {
            logger.info(anchor.name, `[VIDEO] 最新一条: id=${allVideos[0].id} dirTag=${allVideos[0].dirTag} 时间=${tsToBeijing(allVideos[0].createTime)}`);
            const last = allVideos[allVideos.length - 1];
            logger.info(anchor.name, `[VIDEO] 最旧一条: id=${last.id} dirTag=${last.dirTag} 时间=${tsToBeijing(last.createTime)}`);
        }

        const lastTime = getLastTime(anchor.name);

        if (!lastTime) {
            if (allVideos.length === 0) {
                logger.info(anchor.name, '[VIDEO] 没有视频');
                return;
            }
            const latest = allVideos[0];
            logger.info(anchor.name, `[VIDEO] 首次运行，只处理最新 1 条 (${latest.dirTag})`);
            await processOne(anchor, latest, onProcessed);
            setLastTime(anchor.name, latest.dirTag);
            logger.info(anchor.name, `[VIDEO] 首次处理完成`);
            return;
        }

        const toProcess = allVideos.filter(v => v.dirTag > lastTime);
        logger.info(anchor.name, `[VIDEO] 基准: ${lastTime}，新视频 ${toProcess.length} 个`);
        if (toProcess.length === 0) {
            logger.info(anchor.name, '[VIDEO] 没有新视频');
            return;
        }

        // 从旧到新处理
        toProcess.sort((a, b) => a.createTime - b.createTime);
        logger.info(anchor.name, `[VIDEO] 待处理: ${toProcess.map(v => v.dirTag).join(', ')}`);
        for (const target of toProcess) {
            await processOne(anchor, target, onProcessed);
        }

        setLastTime(anchor.name, allVideos[0].dirTag);
        logger.info(anchor.name, `[VIDEO] ===== 检查完成 =====`);
    } catch (e: any) {
        logger.error(anchor.name, `[VIDEO] 检查失败: ${e.message}`);
        logger.error(anchor.name, `[VIDEO] 堆栈: ${e.stack}`);
    }
}

function extractSecUserId(url: string): string | null {
    const m = url.match(/\/user\/([A-Za-z0-9_\-]+)/);
    return m ? m[1] : null;
}

async function fetchPostList(secUserId: string, cookie: string): Promise<VideoMeta[]> {
    const params =
        'device_platform=webapp&aid=6383&channel=channel_pc_web'
        + `&sec_user_id=${secUserId}`
        + `&max_cursor=0&count=${FETCH_COUNT}&publish_video_strategy_type=2`
        + '&update_version_code=170400&pc_client_type=1'
        + '&version_code=290100&version_name=29.1.0'
        + '&cookie_enabled=true&screen_width=1920&screen_height=1080'
        + '&browser_language=zh-CN&browser_platform=MacIntel'
        + '&browser_name=Chrome&browser_version=137.0.0.0'
        + '&browser_online=true&engine_name=Blink&engine_version=137.0.0.0'
        + '&os_name=Mac&os_version=10.15.7&cpu_core_num=8&device_memory=8'
        + '&platform=PC&downlink=10&effective_type=4g&round_trip_time=50'
        + '&webid=7686350976520947215';

    logger.info('system', `[VIDEO] 调 signUrl() ...`);
    const t0 = Date.now();
    const url = signUrl(params, '/aweme/v1/web/aweme/post/');
    const tSign = Date.now() - t0;
    logger.info('system', `[VIDEO] signUrl 完成 (${tSign}ms), URL 长度=${url.length}`);
    logger.info('system', `[VIDEO] a_bogus=${/a_bogus=/.test(url) ? '✅' : '❌'} x-secsdk-web-signature=${/x-secsdk-web-signature=/.test(url) ? '✅' : '❌'}`);

    logger.info('system', `[VIDEO] fetch 请求中 ...`);
    const t1 = Date.now();
    const resp = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Cookie': cookie,
            'Referer': 'https://www.douyin.com/',
        },
    });
    const tFetch = Date.now() - t1;
    logger.info('system', `[VIDEO] fetch 返回 (${tFetch}ms) HTTP ${resp.status}`);

    const text = await resp.text();
    logger.info('system', `[VIDEO] 响应体 ${text.length} 字节`);

    let data: any;
    try {
        data = JSON.parse(text);
    } catch (e: any) {
        logger.error('system', `[VIDEO] 响应不是 JSON，前 300 字: ${text.slice(0, 300)}`);
        throw new Error(`响应不是 JSON: ${e.message}`);
    }

    logger.info('system', `[VIDEO] status_code = ${data.status_code}, status_msg = ${data.status_msg || '(空)'}`);

    if (data.status_code !== 0) {
        logger.error('system', `[VIDEO] 接口报错，响应前 500 字: ${text.slice(0, 500)}`);
        throw new Error(`接口返回 status_code=${data.status_code}, msg=${data.status_msg || ''}`);
    }

    const list = data.aweme_list || [];
    logger.info('system', `[VIDEO] aweme_list 长度 = ${list.length}`);
    if (list.length === 0) {
        logger.warn('system', `[VIDEO] aweme_list 为空，可能没有视频或 cookie 权限不足`);
    }

    return list.map((a: any) => {
        const ts = Number(a.create_time);
        return {
            id: a.aweme_id,
            createTime: ts,
            dirTag: tsToDirTag(ts),
            aweme: a,
        };
    });
}

async function processOne(
    anchor: Anchor,
    meta: VideoMeta,
    onProcessed: (result: VideoProcessResult) => Promise<void>,
): Promise<void> {
    const {id: videoId, createTime, dirTag, aweme} = meta;
    const bjTime = tsToBeijing(createTime);
    logger.info(anchor.name, `[VIDEO] ----- 处理视频 -----`);
    logger.info(anchor.name, `[VIDEO] id=${videoId}`);
    logger.info(anchor.name, `[VIDEO] 发布时间(北京)=${bjTime}`);
    logger.info(anchor.name, `[VIDEO] dirTag=${dirTag}`);
    logger.info(anchor.name, `[VIDEO] 标题=${(aweme?.desc || '(无)').slice(0, 50)}`);

    const tAll = Date.now();
    try {
        const videoDir = path.join(RECORDS_DIR, anchor.name, 'video', dirTag);
        fs.mkdirSync(videoDir, {recursive: true});
        logger.info(anchor.name, `[VIDEO] 视频目录=${videoDir}`);

        const tmpDir = path.join(RECORDS_DIR, anchor.name, 'video', '.tmp');
        fs.mkdirSync(tmpDir, {recursive: true});

        const playAddr =
            aweme?.video?.play_addr?.url_list?.[0]
            || aweme?.video?.bit_rate?.[0]?.play_addr?.url_list?.[0];
        if (!playAddr) {
            logger.error(anchor.name, `[VIDEO] 无播放地址 ${videoId}`);
            return;
        }
        logger.info(anchor.name, `[VIDEO] 播放地址=${playAddr.slice(0, 80)}...`);

        const videoPath = path.join(tmpDir, `${videoId}.mp4`);
        logger.info(anchor.name, `[VIDEO] 下载视频中 ...`);
        const tDl = Date.now();
        await downloadToFile(playAddr, videoPath);
        const sizeMb = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
        logger.info(anchor.name, `[VIDEO] 下载完成 (${((Date.now() - tDl) / 1000).toFixed(1)}s, ${sizeMb} MB)`);

        const audioPath = path.join(videoDir, `${videoId}.m4a`);
        logger.info(anchor.name, `[VIDEO] 提取音频中 ...`);
        const tFf = Date.now();
        await execFileAsync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '96k', audioPath,
        ]);
        logger.info(anchor.name, `[VIDEO] 音频提取完成 (${((Date.now() - tFf) / 1000).toFixed(1)}s) -> ${path.basename(audioPath)}`);

        // ========== ASR（受 VIDEO_ASR_MODE 控制） ==========
        const t0 = Date.now();
        let text = '';
        if (VIDEO_ASR_MODE === 'stream') {
            // Gemini Live 优先，失败降级 SenseVoice
            logger.info(anchor.name, `[VIDEO] ASR (Gemini Live) ...`);
            try {
                const {transcribeFile} = await import('../asr/gemini-live-file.js');
                text = await transcribeFile(audioPath);
                logger.info(anchor.name, `[VIDEO] ASR (Gemini Live) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
            } catch (e: any) {
                logger.warn(anchor.name, `[VIDEO] Gemini Live 失败，降级 SenseVoice: ${e.message}`);
                const {transcribe} = await import('../asr/sensevoice.js');
                text = await transcribe(audioPath);
                logger.info(anchor.name, `[VIDEO] ASR (SenseVoice) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
            }
        } else {
            // SenseVoice 优先，失败降级 Gemini Live
            logger.info(anchor.name, `[VIDEO] ASR (SenseVoice) ...`);
            try {
                const {transcribe} = await import('../asr/sensevoice.js');
                text = await transcribe(audioPath);
                logger.info(anchor.name, `[VIDEO] ASR (SenseVoice) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
            } catch (e: any) {
                logger.warn(anchor.name, `[VIDEO] SenseVoice 失败，降级 Gemini Live: ${e.message}`);
                const {transcribeFile} = await import('../asr/gemini-live-file.js');
                text = await transcribeFile(audioPath);
                logger.info(anchor.name, `[VIDEO] ASR (Gemini Live) 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} 字)`);
            }
        }

        fs.writeFileSync(path.join(videoDir, `${videoId}.txt`), text, 'utf-8');
        logger.info(anchor.name, `[VIDEO] 文字稿已写入 ${videoId}.txt`);

        let summary = text;
        const tAI = Date.now();
        try {
            logger.info(anchor.name, `[VIDEO] AI 总结 ...`);
            const {summarizeSegment} = await import('../ai/index.js');
            summary = await summarizeSegment(text);
            logger.info(anchor.name, `[VIDEO] AI 总结完成 (${((Date.now() - tAI) / 1000).toFixed(1)}s, ${summary.length} 字)`);
        } catch (e: any) {
            logger.error(anchor.name, `[VIDEO] AI 降级链全部失败，用原始文本: ${e.message}`);
        }

        fs.writeFileSync(path.join(videoDir, `${videoId}.summary.txt`), summary, 'utf-8');
        logger.info(anchor.name, `[VIDEO] 总结已写入 ${videoId}.summary.txt`);

        fs.unlinkSync(videoPath);
        logger.info(anchor.name, `[VIDEO] 临时 mp4 已删除`);

        logger.info(anchor.name, `[VIDEO] 回调 onProcessed ...`);
        await onProcessed({
            anchor,
            videoId,
            publishTime: bjTime,
            dirTag,
            text,
            summary,
            videoDir,
        });

        logger.info(anchor.name, `[VIDEO] ✅ 视频处理完成，总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s`);
    } catch (e: any) {
        logger.error(anchor.name, `[VIDEO] ❌ 处理失败 ${videoId}: ${e.message}`);
        logger.error(anchor.name, `[VIDEO] 堆栈: ${e.stack}`);
    }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
    const resp = await fetch(url, {
        headers: {'User-Agent': UA},
        redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(dest, buf);
}