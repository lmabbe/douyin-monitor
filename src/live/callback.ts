/**
 * 直播录音回调：切片总结 / 流式总结
 *
 * 依赖：config.ts, runtime.ts, wechat.ts, live/summary.ts, logger.ts
 */
import fs from 'fs';
import path from 'path';
import {Anchor} from '../douyin/types.js';
import {logger} from '../logger.js';
import {pushToWechat} from '../wechat/wechat.js';
import {fmtErr, segmentCounters} from '../runtime.js';
import {AI_SUMMARY_EVERY} from '../config.js';
import {formatBeijingTime} from './summary.js';
import {summarizeSegment} from '../ai'

// ========== 切片模式 ==========
export async function onSegmentReady(
    anchor: Anchor,
    segmentPath: string,
    hourDir: string
): Promise<void> {
    const name = path.basename(segmentPath);
    logger.info(anchor.name, `[LIVE] ASR start: ${name}`);
    const t0 = Date.now();
    try {
        const rawText = await (await import('../asr/sensevoice.js')).transcribe(segmentPath);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (!rawText) {
            logger.warn(anchor.name, `[LIVE] ASR 空结果: ${name}`);
            return;
        }

        const timeTag = formatBeijingTime(new Date());
        const transcriptPath = path.join(hourDir, 'transcript.txt');
        fs.appendFileSync(
            transcriptPath,
            `[${timeTag}] [${name}] ${rawText.replace(/\s+/g, ' ').trim()}\n`,
            'utf-8'
        );

        // 每 AI_SUMMARY_EVERY 个切片做一次总结
        const cnt = (segmentCounters.get(anchor.name) || 0) + 1;
        segmentCounters.set(anchor.name, cnt);
        if (cnt % AI_SUMMARY_EVERY !== 0) {
            logger.info(
                anchor.name,
                `[LIVE] ASR done (${dt}s) -> transcript.txt (跳过 AI 总结, ${cnt}/${AI_SUMMARY_EVERY})`
            );
            return;
        }

        let text = rawText;
        try {
            text = await summarizeSegment(rawText);
        } catch (e: any) {
            logger.error(anchor.name, `[LIVE] AI 降级链全部失败: ${fmtErr(e)}`);
        }
        const summaryPath = path.join(hourDir, 'summary.txt');
        fs.appendFileSync(summaryPath, `\n## ${timeTag} (${name})\n${text}\n`, 'utf-8');
        logger.info(anchor.name, `[LIVE] summary done (${dt}s) -> summary.txt`);

        await pushToWechat('LIVE', anchor, name, timeTag, text);
    } catch (err: any) {
        logger.error(anchor.name, `[LIVE] ASR 失败: ${name} - ${fmtErr(err)}`);
        logger.error(anchor.name, `[LIVE] ASR 堆栈: ${err.stack}`);
    }
}

// ========== 流式模式 ==========
export async function onStreamFlush(
    anchor: Anchor,
    text: string,
    hourDir: string
): Promise<void> {
    if (!text.trim()) return;

    const t0 = Date.now();
    let summary = text;
    try {
        summary = await summarizeSegment(text);
    } catch (e: any) {
        logger.error(anchor.name, `[LIVE] AI 降级链全部失败，用原始文本: ${fmtErr(e)}`);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(anchor.name, `[LIVE] summary done (${dt}s) -> summary.txt`);

    const summaryPath = path.join(hourDir, 'summary.txt');
    const timeTag = formatBeijingTime(new Date());
    fs.appendFileSync(summaryPath, `\n## ${timeTag}\n${summary}\n`, 'utf-8');

    await pushToWechat('LIVE', anchor, 'stream', timeTag, summary);
}