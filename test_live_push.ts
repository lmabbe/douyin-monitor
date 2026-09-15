import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { WxLinkClient } from 'wx-link';

const RECORDS_DIR = path.join(process.cwd(), 'records');
const ANCHOR = process.argv[2] || 'test';

const anchorDir = path.join(RECORDS_DIR, ANCHOR, 'live');
const dirs = fs.readdirSync(anchorDir).filter(d => /^\d{12}$/.test(d)).sort();
const latest = dirs[dirs.length - 1];
const summaryPath = path.join(anchorDir, latest, 'summary.md');
if (!fs.existsSync(summaryPath)) {
  console.error(`❌ 没找到 ${summaryPath}`);
  process.exit(1);
}

const summary = fs.readFileSync(summaryPath, 'utf-8');

// 北京时间
function formatBeijingTime(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ` +
         `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}
const timeTag = formatBeijingTime(new Date());

const cred = JSON.parse(fs.readFileSync('.wechat-cred.json', 'utf-8'));
if (!cred.targetUserId || !cred.contextToken) {
  console.error('❌ 微信凭证不完整，先在微信里给 Bot 发一条消息');
  process.exit(1);
}

const client = new WxLinkClient({ baseUrl: cred.baseUrl, token: cred.botToken });

const msg = `【LIVE】【${ANCHOR}】【总结】${timeTag}\n${summary.slice(0, 1500)}`;
console.log('将要推送:');
console.log(msg.slice(0, 400));
console.log('...\n');

try {
  await client.sendText({
    toUserId: cred.targetUserId,
    text: msg,
    contextToken: cred.contextToken,
  });
  console.log('✅ 已推送，检查微信');
} catch (e: any) {
  console.error(`❌ 推送失败: ${e.message}`);
}
