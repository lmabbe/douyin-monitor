/**
 * 视频处理回调：落盘总结 + 微信推送
 *
 * 依赖：wechat.ts, logger.ts, runtime.ts, video/index.ts
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { pushToWechat } from '../wechat/wechat.js';
import { fmtErr } from '../runtime.js';
import { VideoProcessResult } from './index.js';

export async function onVideoProcessed(result: VideoProcessResult): Promise<void> {
  try {
    const timeTag = result.publishTime;
    const summaryPath = path.join(result.videoDir, 'summary.txt');
    fs.appendFileSync(
      summaryPath,
      `\n## ${timeTag} [VIDEO] ${result.videoId}\n${result.summary}\n`,
      'utf-8'
    );
    await pushToWechat('VIDEO', result.anchor, result.videoId, timeTag, result.summary);
  } catch (e: any) {
    logger.error(result.anchor.name, `[VIDEO] onProcessed 失败: ${fmtErr(e)}`);
  }
}