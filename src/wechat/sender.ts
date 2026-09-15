/**
 * 微信桥接：用 wx-link 把 outbox.jsonl 的内容发到微信 ClawBot
 * 运行：npx tsx src/wechat/sender.ts
 */
import fs from 'fs';
import path from 'path';
import { loginWithQR, WxLinkClient } from 'wx-link';

const OUTBOX = path.join(process.cwd(), 'outbox.jsonl');
const CRED_FILE = path.join(process.cwd(), '.wechat-cred.json');
const POLL_MS = 10_000;

interface Cred {
  baseUrl: string;
  botToken: string;
  cursor: string;
  targetUserId?: string;
  contextToken?: string;
}

function loadCred(): Cred | null {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8')); }
  catch { return null; }
}
function saveCred(c: Cred) {
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

async function main() {
  let cred = loadCred();
  let client: WxLinkClient;

  if (cred) {
    console.log('[wechat] 使用已保存凭证');
    client = new WxLinkClient({ baseUrl: cred.baseUrl, token: cred.botToken });
  } else {
    console.log('[wechat] 首次运行，请扫码登录');
    const login = await loginWithQR({
      onQRCode: (url) => {
        console.log('\n=== 请用微信扫码 ===\n' + url + '\n====================\n');
      },
    });
    cred = { baseUrl: login.baseUrl, botToken: login.botToken, cursor: '' };
    saveCred(cred);
    client = new WxLinkClient({ baseUrl: login.baseUrl, token: login.botToken });
  }

  // 轮询微信消息，捕获你的 userId 和 context_token
  const pollWechat = async () => {
    try {
      const updates = await client.poll(cred!.cursor);
      cred!.cursor = updates.nextCursor ?? cred!.cursor;
      for (const msg of updates.msgs ?? []) {
        if (msg.from_user_id && msg.context_token) {
          if (!cred!.targetUserId) {
            console.log(`[wechat] 已捕获目标用户: ${msg.from_user_id}`);
          }
          cred!.targetUserId = msg.from_user_id;
          cred!.contextToken = msg.context_token;
          saveCred(cred!);
        }
      }
    } catch (e: any) {
      if (!e.message?.includes('timeout')) console.error(`[wechat] poll: ${e.message}`);
    }
  };

  // 轮询 outbox，发送新内容
  const pollOutbox = async () => {
    if (!cred!.targetUserId || !cred!.contextToken) return;
    if (!fs.existsSync(OUTBOX)) return;

    let content: string;
    try { content = fs.readFileSync(OUTBOX, 'utf-8'); } catch { return; }
    if (!content.trim()) return;

    const lines = content.trim().split('\n');
    fs.writeFileSync(OUTBOX, '', 'utf-8');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = `【${entry.anchor}】${entry.time}\n${entry.text}`;
        const finalMsg = msg.length > 1500 ? msg.slice(0, 1500) + '...' : msg;
        await client.sendText({
          toUserId: cred!.targetUserId,
          text: finalMsg,
          contextToken: cred!.contextToken,
        });
        console.log(`[wechat] 已发送: ${entry.file}`);
      } catch (e: any) {
        console.error(`[wechat] 发送失败: ${e.message}`);
      }
    }
  };

  setInterval(pollWechat, POLL_MS);
  setInterval(pollOutbox, POLL_MS);
  await pollWechat();
  await pollOutbox();
  console.log('[wechat] 桥接已启动，等待新切片...');
}

main().catch(e => { console.error('[wechat] FATAL:', e.message); process.exit(1); });
