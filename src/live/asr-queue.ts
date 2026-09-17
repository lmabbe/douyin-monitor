/**
 * ASR 队列（切片模式）：串行处理切片，避免并发压垮 ASR
 *
 * 依赖：live/callback.ts, logger.ts, runtime.ts
 */
import {Anchor} from '../douyin/types.js';
import {logger} from '../logger.js';
import {fmtErr} from '../runtime.js';
import {onSegmentReady} from './callback.js';

export interface AsrJob {
    anchor: Anchor;
    segmentPath: string;
    hourDir: string;
}

const asrQueue: AsrJob[] = [];
let asrRunning = false;

/** 等待队列清空（下播时用，确保所有切片处理完） */
export async function waitForAsrIdle(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const t0 = Date.now();
    while (asrRunning && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
    }
    const waited = ((Date.now() - t0) / 1000).toFixed(1);
    if (asrRunning) {
        logger.warn('system', `[ASR] 等待 ${waited}s 后仍未清空，继续生成总结`);
    } else if (Number(waited) > 1) {
        logger.info('system', `[ASR] 等待 ${waited}s，队列已清空`);
    }
}

/** 推入队列，串行执行 */
export async function processAsrQueue(job: AsrJob): Promise<void> {
    asrQueue.push(job);
    if (asrRunning) return;
    asrRunning = true;
    while (asrQueue.length > 0) {
        // 积压超过 5 个，丢弃中间部分，只保留最早 2 个 + 最新
        if (asrQueue.length > 5) {
            const dropped = asrQueue.splice(0, asrQueue.length - 2);
            logger.warn('system', `ASR 积压，丢弃 ${dropped.length} 个切片`);
        }
        const j = asrQueue.shift()!;
        try {
            await onSegmentReady(j.anchor, j.segmentPath, j.hourDir);
        } catch (e: any) {
            logger.error(j.anchor.name, `ASR 队列任务失败: ${fmtErr(e)}`);
        }
    }
    asrRunning = false;
}