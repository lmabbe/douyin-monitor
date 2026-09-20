/**
 * 直播相关的辅助函数：时间、目录、开播提醒、下播总结
 *
 * 依赖：config.ts, wechat.ts, logger.ts
 */
import fs from 'fs';
import path from 'path';
import {Anchor, LiveInfo} from '../douyin/types.js';
import {logger} from '../logger.js';
import {pushToWechat} from '../wechat/wechat.js';
import {RECORDS_DIR} from '../config.js';
import {fmtErr} from '../runtime.js';
import {summarizeSession} from '../ai'

// ========== 时间格式化 ==========
export function formatBeijingTime(d: Date): string {
    const bj = new Date(d.getTime() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return (
        `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ` +
        `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`
    );
}

// ========== 找最新的 transcript ==========
export function findLatestTranscript(anchorName: string): string | null {
    const anchorDir = path.join(RECORDS_DIR, anchorName, 'live');
    if (!fs.existsSync(anchorDir)) return null;
    const dirs = fs
        .readdirSync(anchorDir)
        .filter((d) => /^\d{12}(_\d+)?$/.test(d))
        .sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
        const p = path.join(anchorDir, dirs[i], 'transcript.txt');
        if (fs.existsSync(p)) return p;
        const p2 = path.join(anchorDir, dirs[i], 'live_transcript.txt');
        if (fs.existsSync(p2)) return p2;
    }
    return null;
}

// ========== 直播目录 ==========
/**
 * 复用或新建本场直播目录
 *   - 已有 _{roomId} 结尾的目录 → 复用
 *   - 否则新建 {YYYYMMDDHHmm}_{roomId}
 */
export function resolveLiveDir(anchorName: string, roomId: string): string {
    const baseDir = path.join(RECORDS_DIR, anchorName, 'live');
    fs.mkdirSync(baseDir, {recursive: true});

    if (roomId) {
        try {
            const dirs = fs.readdirSync(baseDir);
            const existing = dirs.find((d) => d.endsWith(`_${roomId}`));
            if (existing) {
                const full = path.join(baseDir, existing);
                logger.info(anchorName, `[LIVE] 复用已有目录: ${existing}`);
                return full;
            }
        } catch {
        }
    }

    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const tag = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(
        now.getHours()
    )}${p(now.getMinutes())}`;
    const dirName = roomId ? `${tag}_${roomId}` : tag;
    const full = path.join(baseDir, dirName);
    fs.mkdirSync(full, {recursive: true});
    logger.info(anchorName, `[LIVE] 新建目录: ${dirName}`);
    return full;
}

// ========== 开播提醒 ==========
export async function pushLiveStart(anchor: Anchor, live: LiveInfo): Promise<void> {
    const timeTag = formatBeijingTime(new Date());
    const roomUrl = anchor.webRid ? `https://live.douyin.com/${anchor.webRid}` : '';
    const text = [
        `标题：${live.title || '(无)'}`,
        live.roomId ? `房间：${live.roomId}` : '',
        roomUrl ? `链接：${roomUrl}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    logger.info(anchor.name, `[LIVE] 开播提醒`);
    await pushToWechat('LIVE', anchor, 'start', timeTag, text);
}

// ========== 下播总结 ==========
export async function generateAndPushSummary(anchor: Anchor): Promise<void> {
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
        summary = await summarizeSession(fullText);
    } catch (e: any) {
        logger.error(anchor.name, `[LIVE] 所有 AI 都失败: ${fmtErr(e)}`);
        return;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const summaryPath = path.join(path.dirname(transcriptPath), 'summary.md');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    logger.info(anchor.name, `[LIVE] 总结完成 (${dt}s) -> ${summaryPath}`);

    const timeTag = formatBeijingTime(new Date());
    await pushToWechat('LIVE', anchor, 'summary.md', timeTag, `【直播总结】\n${summary.slice(0, 1500)}`);
}