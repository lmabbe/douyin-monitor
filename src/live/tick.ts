/**
 * 直播主循环 tick：检查状态 → 开播 → 录音 → 下播
 *
 * 依赖：config.ts, runtime.ts, wechat.ts, live/summary.ts, live/callback.ts, live/asr-queue.ts, douyin, recorder
 */
import {getLiveInfo} from '../douyin/index.js';
import {AnchorState, LiveInfo} from '../douyin/types.js';
import {logger} from '../logger.js';
import {fmtErr, fmtLive, enterError, AnchorRuntime} from '../runtime.js';
import {CHECK_FAIL_LIMIT, ERROR_COOLDOWN_MS, OFFLINE_THRESHOLD, STREAM_FAIL_LIMIT, ASR_MODE} from '../config.js';
import {
    generateAndPushSummary,
    pushLiveStart,
    resolveLiveDir,
} from './summary.js';
import {onStreamFlush} from './callback.js';
import {waitForAsrIdle} from './asr-queue.js';

export async function tick(rt: AnchorRuntime): Promise<void> {
    const {anchor} = rt;

    if (!anchor.webRid) return;

    // ========== ERROR 冷却恢复 ==========
    if (rt.state === AnchorState.ERROR) {
        const elapsed = Date.now() - rt.lastErrorAt;
        if (elapsed < ERROR_COOLDOWN_MS) {
            return; // 冷却中静默跳过
        }
        logger.info(
            anchor.name,
            `[STATE] ERROR -> OFFLINE | 冷却结束 (elapsed=${(elapsed / 1000).toFixed(0)}s) | ` +
            `上次原因="${rt.lastErrorReason}" | 重试`
        );
        rt.state = AnchorState.OFFLINE;
        rt.checkFailCount = 0;
        rt.streamFailCount = 0;
        rt.lastErrorReason = '';
    }

    // ========== 检查直播状态 ==========
    const tCheck = Date.now();
    let live: LiveInfo;
    try {
        live = await getLiveInfo(anchor);
        const dtCheck = Date.now() - tCheck;
        if (rt.checkFailCount > 0) {
            logger.info(anchor.name, `[LIVE] 检查恢复正常 (之前失败 ${rt.checkFailCount} 次, ${dtCheck}ms)`);
        }
        rt.checkFailCount = 0;
    } catch (err: any) {
        const dtCheck = Date.now() - tCheck;
        rt.checkFailCount++;
        logger.error(
            anchor.name,
            `[LIVE] 检查直播状态失败 (${rt.checkFailCount}/${CHECK_FAIL_LIMIT}) | ` +
            `webRid=${anchor.webRid} | 耗时=${dtCheck}ms | ${fmtErr(err)}`
        );
        logger.error(anchor.name, `[LIVE] 检查失败堆栈: ${err?.stack || '(无堆栈)'}`);
        if (rt.checkFailCount >= CHECK_FAIL_LIMIT) {
            enterError(rt, `getLiveInfo 连续 ${rt.checkFailCount} 次失败: ${err?.message || 'unknown'}`);
        }
        return;
    }

    // ========== 离线分支 ==========
    if (!live.isLive) {
        rt.offlineCount = Math.min(rt.offlineCount + 1, OFFLINE_THRESHOLD + 1);
        logger.info(anchor.name, `[LIVE] OFFLINE (${rt.offlineCount}/${OFFLINE_THRESHOLD}) state=${rt.state}`);

        rt.liveNotified = false;

        if (rt.state === AnchorState.RECORDING && rt.offlineCount >= OFFLINE_THRESHOLD) {
            logger.info(anchor.name, `[LIVE] LIVE ended (state=${rt.state}, offline=${rt.offlineCount})`);
            rt.state = AnchorState.OFFLINE;
            logger.info(anchor.name, `[STATE] -> OFFLINE`);
            rt.currentRoomId = null;
            rt.currentLiveDir = null;
            rt.streamFailCount = 0;
            rt.offlineCount = 0;

            // 异步收尾：停录音 + 等 ASR + 生成总结
            (async () => {
                try {
                    if (ASR_MODE === 'stream') {
                        await rt.streamRecorder?.stop(anchor.name);
                    } else {
                        await rt.recorder?.stop(anchor.name);
                    }
                    await waitForAsrIdle();
                    logger.info(anchor.name, '[LIVE] 开始生成总结');
                    await generateAndPushSummary(anchor);
                    logger.info(anchor.name, '[LIVE] 总结生成完成');
                } catch (e: any) {
                    logger.error(anchor.name, `[LIVE] 停止/总结失败: ${fmtErr(e)}`);
                    logger.error(anchor.name, `[LIVE] 停止/总结堆栈: ${e?.stack || '(无堆栈)'}`);
                }
            })();
        }
        return;
    }

    // ========== 开播分支 ==========
    rt.offlineCount = 0;

    const wasNotLive = rt.state !== AnchorState.LIVE && rt.state !== AnchorState.RECORDING;
    if (rt.state !== AnchorState.RECORDING) {
        rt.state = AnchorState.LIVE;
        logger.info(anchor.name, `[STATE] -> LIVE (not recording)`);
    }
    rt.currentRoomId = live.roomId;

    // 开播提醒（从非 LIVE 变为 LIVE 时推一次）
    if (wasNotLive && !rt.liveNotified) {
        rt.liveNotified = true;
        pushLiveStart(anchor, live).catch((e: any) => {
            logger.error(anchor.name, `[LIVE] 开播提醒推送失败: ${fmtErr(e)}`);
        });
    }

    // 已在录音 → 继续
    const isRec = ASR_MODE === 'stream'
        ? rt.streamRecorder?.isRecording()
        : rt.recorder?.isRecording();
    if (isRec) {
        logger.info(anchor.name, `[LIVE] LIVE (recording, room_id=${live.roomId})`);
        return;
    }

    // 解析流地址
    rt.state = AnchorState.RESOLVING_STREAM;
    logger.info(anchor.name, `[STATE] -> RESOLVING_STREAM`);
    logger.info(anchor.name, `[LIVE] LIVE, room_id=${live.roomId}`);
    logger.info(anchor.name, `[LIVE] resolving stream...`);
    logger.info(anchor.name, `[LIVE] live 详情: ${fmtLive(live)}`);

    if (!live.streamUrl) {
        rt.streamFailCount++;
        logger.error(
            anchor.name,
            `[LIVE] stream URL 为空 (${rt.streamFailCount}/${STREAM_FAIL_LIMIT}) | ` + `live: ${fmtLive(live)}`
        );
        if (rt.streamFailCount >= STREAM_FAIL_LIMIT) {
            enterError(rt, `stream URL 连续 ${rt.streamFailCount} 次为空`);
            rt.streamFailCount = 0;
        }
        return;
    }

    rt.streamFailCount = 0;
    logger.info(anchor.name, `[LIVE] stream resolved (${live.streamFormat})`);
    logger.info(anchor.name, `[LIVE] streamUrl=${live.streamUrl.slice(0, 80)}...`);

    if (!rt.currentLiveDir) {
        rt.currentLiveDir = resolveLiveDir(anchor.name, live.roomId);
    }

    // 启动录音
    try {
        rt.state = AnchorState.RECORDING;
        logger.info(anchor.name, `[STATE] -> RECORDING`);
        if (ASR_MODE === 'stream') {
            rt.streamRecorder?.start(anchor, live, rt.currentLiveDir);
        } else {
            rt.recorder?.start(anchor, live, rt.currentLiveDir);
        }
        logger.info(anchor.name, '[LIVE] recording started');
    } catch (err: any) {
        logger.error(
            anchor.name,
            `[LIVE] 启动录音失败 | format=${live.streamFormat} | ` +
            `streamUrl=${live.streamUrl.slice(0, 60)}... | ${fmtErr(err)}`
        );
        logger.error(anchor.name, `[LIVE] 启动录音堆栈: ${err?.stack || '(无堆栈)'}`);
        enterError(rt, `启动录音失败: ${err?.message || 'unknown'}`);
    }
}