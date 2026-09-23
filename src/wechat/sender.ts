/**
 * 微信账号登录工具：扫码添加新账号
 * 运行：npx tsx src/wechat/sender.ts [--name 备注名] [--subs tag1,tag2]
 */
import fs from 'fs';
import path from 'path';
import {loginWithQR, WxLinkClient} from 'wx-link';
import type {WechatAccount} from './wechat.ts';
import {newAccountId} from './wechat.ts';

const CRED_FILE = path.join(process.cwd(), '.wechat-cred.json');

type PendingAccount = WechatAccount & { pending?: boolean };

function loadAccounts(): PendingAccount[] {
    if (!fs.existsSync(CRED_FILE)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
        if (Array.isArray(data)) return data;
    } catch { /* ignore */
    }
    return [];
}

function saveAccounts(accounts: PendingAccount[]) {
    fs.writeFileSync(CRED_FILE, JSON.stringify(accounts, null, 2), {mode: 0o600});
}

function parseArgs() {
    const args = process.argv.slice(2);
    let name: string | undefined;
    let subs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--name') name = args[++i];
        else if (args[i] === '--subs') subs = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    return {name, subs};
}

async function main() {
    const {name, subs} = parseArgs();
    const qrcode = (await import('qrcode-terminal')).default;

    console.log('[wechat] 扫码登录新账号');
    const login: any = await loginWithQR({
        onQRCode: (url: string) => {
            console.log('\n=== 请用微信扫码 ===\n');
            qrcode.generate(url, {small: true}, (qr: string) => console.log(qr));
            console.log(`\n(扫码不便时可手动打开: ${url})\n====================\n`);
        },
    });

    const account: PendingAccount = {
        id: newAccountId(),
        name: name || `wx_${Date.now().toString(36)}`,
        baseUrl: login.baseUrl,
        botToken: login.botToken,
        cursor: '',
        subscriptions: subs,
        createdAt: new Date().toISOString(),
        pending: true,   // ★ 主程序看到会跳过
    };

    // 先写盘
    const all = loadAccounts();
    all.push(account);
    saveAccounts(all);
    console.log(`[wechat] 账号已保存: ${account.name} (${account.id})`);

    // 等一下，捕获 targetUserId / contextToken
    console.log('\n[wechat] 现在请在微信里给这个 bot 发一条消息（任意内容）');
    console.log('[wechat] 正在等待捕获你的 userId...（3 分钟内有效，Ctrl+C 可跳过）\n');

    const client = new WxLinkClient({baseUrl: account.baseUrl, token: account.botToken});
    const deadline = Date.now() + 3 * 60 * 1000;
    let captured = false;

    while (Date.now() < deadline) {
        try {
            const updates: any = await client.poll(account.cursor);
            account.cursor = updates.nextCursor ?? account.cursor;

            for (const msg of updates.msgs ?? []) {
                if (msg.from_user_id && msg.context_token) {
                    account.targetUserId = msg.from_user_id;
                    account.contextToken = msg.context_token;
                    captured = true;
                    break;
                }
            }

            if (captured) {
                // ★ 回复绑定提示
                try {
                    await client.sendText({
                        toUserId: account.targetUserId!,
                        text: "✅ 绑定成功，之后监控到匹配的切片会推送到这里。",
                        contextToken: account.contextToken!,
                    });
                    console.log('[wechat] 已回复绑定提示');
                } catch (e: any) {
                    console.error(`[wechat] 回复失败: ${e.message}`);
                }

                // ★ 清除 pending，写盘
                account.pending = false;
                const list = loadAccounts();
                const i = list.findIndex(a => a.id === account.id);
                if (i >= 0) list[i] = account;
                else list.push(account);
                saveAccounts(list);
                break;
            }
        } catch (e: any) {
            if (!e.message?.includes('timeout')) {
                console.error(`[wechat] poll: ${e.message}`);
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    if (captured) {
        console.log(`[wechat] ✓ 已捕获 userId: ${account.targetUserId}`);
        console.log('[wechat] 主程序 10s 内会自动开始监听（无需重启）');
    } else {
        console.log('[wechat] ⚠ 未在 3 分钟内捕获到 userId');
        console.log('[wechat] 账号已保存（pending），稍后发消息主程序会自动捕获');
    }
}

main().catch(e => {
    console.error('[wechat] FATAL:', e.message);
    process.exit(1);
});