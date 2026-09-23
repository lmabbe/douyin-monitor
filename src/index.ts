import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {Anchor} from './douyin/types.js';
import {Recorder} from './recorder/recorder.js';
import {StreamRecorder} from './recorder/stream-recorder.js';
import {logger} from './logger.js';
import {formatAiChain} from './ai';
// 本地模块
import {
    ASR_MODE,
    CHECK_FAIL_LIMIT,
    CHECK_INTERVAL_MS,
    ERROR_COOLDOWN_MS,
    nextVideoDelay,
    RECORDS_DIR,
    RELOAD_SIGNAL,
    SEGMENT_SECONDS,
    STREAM_FLUSH_MINUTES,
    VIDEO_RANGE,
} from './config.js';
import {AnchorRuntime, fmtErr, runtimes} from './runtime.js';
import {initWechat, stopWechat} from './wechat/wechat.js';
import {tick} from './live/tick.js';
import {onStreamFlush} from './live/callback.js';
import {processAsrQueue, waitForAsrIdle} from './live/asr-queue.js';
import {onVideoProcessed} from './video/callback.js';
import {checkAnchorVideos} from './video/index.js';
import {reloadPrompts} from './ai/prompts.js';

// ========== 工具 ==========
function loadAnchors(): Anchor[] {
    const p = path.join(process.cwd(), 'config', 'anchors.json');
    if (!fs.existsSync(p)) throw new Error(`找不到配置文件: ${p}`);
    const list = JSON.parse(fs.readFileSync(p, 'utf-8')) as Anchor[];
    return list.filter((a) => a.enabled);
}

/** 为某个主播创建 runtime（含 recorder / streamRecorder） */
function buildRuntime(a: Anchor): AnchorRuntime {
    const recorder = new Recorder({
        recordsDir: RECORDS_DIR,
        segmentSeconds: SEGMENT_SECONDS,
        onSegmentReady: (anchor, segmentPath, hourDir) => {
            processAsrQueue({anchor, segmentPath, hourDir});
        },
        onExit: (anchor, code) => {
            if (code !== 0 && code !== null && code !== 255) {
                logger.warn(anchor.name, `[LIVE] 切片 ffmpeg 退出 code=${code}`);
            }
        },
    });

    const streamRecorder = new StreamRecorder({
        recordsDir: RECORDS_DIR,
        flushSeconds: STREAM_FLUSH_MINUTES * 60,
        onFlush: onStreamFlush,
        onExit: (anchor, code) => {
            if (code !== 0 && code !== null && code !== 255) {
                logger.warn(anchor.name, `[LIVE] 流式 ffmpeg 退出 code=${code}`);
            }
        },
    });

    return {
        anchor: a,
        state: 'OFFLINE' as any,
        offlineCount: 0,
        streamFailCount: 0,
        checkFailCount: 0,
        lastErrorAt: 0,
        lastErrorReason: '',
        currentRoomId: null,
        currentLiveDir: null,
        recorder,
        streamRecorder,
        liveNotified: false,
    };
}

// ========== main 的各步骤 ==========

/** 1. 启动横幅 */
function logStartupBanner(): void {
    logger.sys('=== 抖音直播 + 视频监控启动 ===');
    logger.sys(`ASR 模式: ${ASR_MODE}`);
    logger.sys(`AI 降级链: ${formatAiChain()}`);
    logger.sys(`直播检查间隔: ${CHECK_INTERVAL_MS / 1000}s`);
    logger.sys(
        `视频检查间隔: ${(VIDEO_RANGE.minMs / 60000).toFixed(1)}~${(VIDEO_RANGE.maxMs / 60000).toFixed(
            1
        )} 分钟（随机到秒）`
    );
    logger.sys(
        `直播状态检查失败上限: ${CHECK_FAIL_LIMIT} 次 | ERROR 冷却: ${ERROR_COOLDOWN_MS / 60000} 分钟`
    );
}

/** 2. 读 anchors + 建 runtime */
function initRuntimes(): void {
    const anchors = loadAnchors();
    if (anchors.length === 0) {
        logger.sys('没有启用的主播');
        process.exit(1);
    }
    logger.sys(`已加载 ${anchors.length} 个主播: ${anchors.map((a) => a.name).join(', ')}`);

    for (const a of anchors) {
        runtimes.set(a.name, buildRuntime(a));
    }
}

/** 3. 直播检查循环 */
function startLiveCheckLoop(): void {
    const tickAll = async () => {
        await Promise.all(
            [...runtimes.values()].map(async (rt) => {
                try {
                    await tick(rt);
                } catch (e: any) {
                    logger.error(rt.anchor.name, `tick 异常: ${fmtErr(e)}`);
                    logger.error(rt.anchor.name, `tick 堆栈: ${e?.stack || '(无堆栈)'}`);
                }
            })
        );
    };

    // 立即跑一次，然后定时
    tickAll();
    setInterval(tickAll, CHECK_INTERVAL_MS);
}

/** 4. 配置热重载（监听 .reload 信号文件） */
function startReloadWatcher(): void {
    let reloading = false;

    setInterval(() => {
        if (reloading) return;
        if (!fs.existsSync(RELOAD_SIGNAL)) return;
        try {
            fs.unlinkSync(RELOAD_SIGNAL);
        } catch {
        }
        reloading = true;
        try {
            doReload();
        } catch (e: any) {
            logger.error('system', `[RELOAD] 失败: ${fmtErr(e)}`);
        } finally {
            reloading = false;
        }
    }, 3000);
}

/** 4.1 重载的实际逻辑 */
function doReload(): void {
    logger.sys('[RELOAD] 检测到 .reload 信号，重新加载 anchors.json + prompts.json...');
    reloadPrompts();

    const newAnchors = loadAnchors();
    const newNames = new Set(newAnchors.map((a) => a.name));

    // 移除不再存在的主播
    for (const [name, rt] of runtimes.entries()) {
        if (!newNames.has(name)) {
            logger.sys(`[RELOAD] 移除主播: ${name}`);
            rt.recorder?.stop(name);
            rt.streamRecorder?.stop(name);
            runtimes.delete(name);
        }
    }

    // 新增 / 更新
    for (const a of newAnchors) {
        if (!runtimes.has(a.name)) {
            logger.sys(`[RELOAD] 新增主播: ${a.name}`);
            runtimes.set(a.name, buildRuntime(a));
        } else {
            const rt = runtimes.get(a.name)!;
            if (rt.anchor.webRid !== a.webRid || rt.anchor.videoUrl !== a.videoUrl) {
                logger.sys(`[RELOAD] 更新主播配置: ${a.name}`);
                rt.anchor = a;
            }
        }
    }

    logger.sys(
        `[RELOAD] 完成，当前监控 ${runtimes.size} 个主播: ${[...runtimes.keys()].join(', ')}`
    );
}

/** 5. 视频检查循环（首次 30s，之后随机） */
function startVideoCheckLoop(): void {
    const checkAllVideos = async () => {
        for (const rt of runtimes.values()) {
            try {
                await checkAnchorVideos(rt.anchor, onVideoProcessed);
            } catch (e: any) {
                logger.error(rt.anchor.name, `[VIDEO] 检查异常: ${fmtErr(e)}`);
            }
        }
    };

    const scheduleNext = () => {
        const delay = nextVideoDelay();
        logger.sys(`[VIDEO] 下次检查在 ${(delay / 1000).toFixed(0)} 秒后`);
        setTimeout(async () => {
            await checkAllVideos();
            scheduleNext();
        }, delay);
    };

    // 启动 30 秒后第一次，之后进入随机循环
    setTimeout(() => {
        checkAllVideos().then(() => scheduleNext());
    }, 30_000);
}

/** 6. 优雅退出 */
function installShutdownHandlers(): void {
    let shuttingDown = false;

    const shutdown = async (sig: string) => {
        if (shuttingDown) {
            logger.sys(`收到 ${sig}，已在清理中，忽略`);
            return;
        }
        shuttingDown = true;
        logger.sys(`收到 ${sig}，清理中...`);

        const hardKill = setTimeout(() => {
            logger.error('system', 'shutdown 超时 30s，强制退出');
            process.exit(1);
        }, 30_000);
        hardKill.unref();

        try {
            // ★ 先停微信轮询（外围）
            try {
                stopWechat();
                logger.sys('微信轮询已停止');
            } catch (e: any) {
                logger.warn('system', `stopWechat 失败: ${fmtErr(e)}`);
            }

            await Promise.all(
                [...runtimes.values()].map(async (rt) => {
                    try {
                        await rt.recorder?.stop(rt.anchor.name);
                    } catch (e: any) {
                        logger.warn(rt.anchor.name, `recorder.stop 失败: ${fmtErr(e)}`);
                    }
                    try {
                        await rt.streamRecorder?.stop(rt.anchor.name);
                    } catch (e: any) {
                        logger.warn(rt.anchor.name, `streamRecorder.stop 失败: ${fmtErr(e)}`);
                    }
                })
            );

            await waitForAsrIdle(10_000);
            logger.sys('清理完成，退出');
        } finally {
            clearTimeout(hardKill);
            process.exit(0);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ========== 入口 ==========
async function main(): Promise<void> {
    logStartupBanner();
    await initWechat();
    initRuntimes();
    startLiveCheckLoop();
    startReloadWatcher();
    startVideoCheckLoop();
    installShutdownHandlers();
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});