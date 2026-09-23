/**
 * 微信桥接：多账号登录、轮询、按订阅推送、账号热加载
 *
 * 依赖：config.ts, runtime.ts, logger.ts, wx-link
 */
import fs from 'fs';
import crypto from 'crypto';
import {Anchor} from '../douyin/types.js';
import {logger} from '../logger.js';
import {fmtErr} from '../runtime.js';
import {OUTBOX_FILE, WECHAT_CRED_FILE} from '../config.js';

/** 单个微信账号 */
export interface WechatAccount {
    /** 稳定主键，生成一次永不变 */
    id: string;
    /** 备注名 */
    name?: string;
    baseUrl: string;
    /** 每次登录可能变化，只当可变字段 */
    botToken: string;
    cursor: string;
    targetUserId?: string;
    contextToken?: string;
    /** 订阅的 tag 数组，空 = 全部 */
    subscriptions: string[];
    createdAt: string;
    /** true = 由 sender 登录中，主程序跳过 */
    pending?: boolean;
}

interface AccountRuntime {
    account: WechatAccount;
    client: any;
    pollTimer?: NodeJS.Timeout;
}

const runtimes = new Map<string, AccountRuntime>();
let syncTimer: NodeJS.Timeout | null = null;

// ---------------- 工具 ----------------

export function newAccountId(): string {
    return 'wx_' + crypto.randomUUID();
}

/** 身份键：同一个微信号 + 同一个 bot 才视为同一条 */
function identityKey(a: WechatAccount): string | null {
    if (!a.targetUserId || !a.botToken) return null;
    const botId = a.botToken.split('@')[0];
    return `${a.targetUserId}|${botId}`;
}

// ---------------- 账号文件读写 ----------------

export function loadAccounts(): WechatAccount[] {
    if (!fs.existsSync(WECHAT_CRED_FILE)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(WECHAT_CRED_FILE, 'utf-8'));

        if (Array.isArray(data)) {
            return data.map((a: any) => ({
                id: a.id || newAccountId(),
                name: a.name,
                baseUrl: a.baseUrl,
                botToken: a.botToken,
                cursor: a.cursor ?? '',
                targetUserId: a.targetUserId,
                contextToken: a.contextToken,
                subscriptions: Array.isArray(a.subscriptions) ? a.subscriptions : [],
                createdAt: a.createdAt || new Date().toISOString(),
                pending: !!a.pending,
            }));
        }

        // 旧格式：单对象 -> 迁移
        if (data && data.baseUrl && data.botToken) {
            const migrated: WechatAccount = {
                id: newAccountId(),
                name: 'default',
                baseUrl: data.baseUrl,
                botToken: data.botToken,
                cursor: data.cursor ?? '',
                targetUserId: data.targetUserId,
                contextToken: data.contextToken,
                subscriptions: [],
                createdAt: new Date().toISOString(),
                pending: false,
            };
            saveAccounts([migrated]);
            logger.sys('[wechat] 已迁移旧凭证到多账号格式');
            return [migrated];
        }
    } catch (e: any) {
        logger.error('wechat', `解析凭证失败: ${e.message}`);
    }
    return [];
}

export function saveAccounts(accounts: WechatAccount[]): void {
    fs.writeFileSync(WECHAT_CRED_FILE, JSON.stringify(accounts, null, 2), {mode: 0o600});
}

// ---------------- 单账号启动/停止 ----------------

async function startAccount(account: WechatAccount): Promise<void> {
    const {WxLinkClient} = await import('wx-link');
    const client = new WxLinkClient({baseUrl: account.baseUrl, token: account.botToken});
    const rt: AccountRuntime = {account, client};

    const poll = async () => {
        try {
            const updates: any = await client.poll(account.cursor);
            account.cursor = updates.nextCursor ?? account.cursor;
            let changed = false;
            for (const msg of updates.msgs ?? []) {
                if (msg.from_user_id && msg.context_token) {
                    const isFirst = !account.targetUserId;
                    account.targetUserId = msg.from_user_id;
                    account.contextToken = msg.context_token;
                    changed = true;

                    // ★ 首次捕获才回复
                    if (isFirst) {
                        try {
                            await client.sendText({
                                toUserId: msg.from_user_id,
                                text: "✅ 绑定成功，之后监控到匹配的切片会推送到这里。",
                                contextToken: msg.context_token,
                            });
                            logger.sys(`[wechat][${account.name || account.id}] 已回复绑定提示`);
                        } catch (e: any) {
                            logger.error('wechat', `[${account.name || account.id}] 回复失败: ${fmtErr(e)}`);
                        }
                    }
                }
            }
            if (changed) persistAccount(account);
        } catch (e: any) {
            if (!e.message?.includes('timeout')) {
                logger.error('wechat', `[${account.name || account.id}] poll: ${e.message}`);
            }
        }
    };

    rt.pollTimer = setInterval(poll, 10_000);
    runtimes.set(account.id, rt);
    logger.sys(`[wechat][${account.name || account.id}] 监听已启动`);
}

function stopAccount(id: string): void {
    const rt = runtimes.get(id);
    if (!rt) return;
    if (rt.pollTimer) clearInterval(rt.pollTimer);
    runtimes.delete(id);
    logger.sys(`[wechat][${rt.account.name || id}] 监听已停止`);
}

function persistAccount(account: WechatAccount): void {
    const all = loadAccounts();
    const idx = all.findIndex(a => a.id === account.id);
    if (idx >= 0) all[idx] = account;
    else all.push(account);
    saveAccounts(all);
}

// ---------------- 热加载：增/删/改 ----------------

async function syncAccounts(): Promise<void> {
    let accounts: WechatAccount[] = [];
    try {
        accounts = loadAccounts();
    } catch (e: any) {
        logger.error('wechat', `热加载读取失败: ${e.message}`);
        return;
    }

    // ★ 1. 过滤 pending
    const active = accounts.filter(a => !a.pending);
    const pendingCount = accounts.length - active.length;
    if (pendingCount > 0) {
        logger.sys(`[wechat] 跳过 ${pendingCount} 个 pending 账号（sender 登录中）`);
    }

    // ★ 2. 按身份键去重（同一微信号 + 同一 bot 只留一条）
    const byIdentity = new Map<string, WechatAccount>();
    const noIdentity: WechatAccount[] = [];
    for (const acc of active) {
        const key = identityKey(acc);
        if (!key) {
            noIdentity.push(acc);
            continue;
        }
        const exist = byIdentity.get(key);
        if (!exist || (acc.createdAt || '') > (exist.createdAt || '')) {
            byIdentity.set(key, acc);
        }
    }
    const deduped = [...byIdentity.values(), ...noIdentity];

    // 若去重后有变化，回写文件（删掉重复条目 + 保留 pending）
    if (deduped.length !== active.length) {
        logger.sys(`[wechat] 去重：${active.length} -> ${deduped.length} 条活跃账号`);
        const pendingOnes = accounts.filter(a => a.pending);
        saveAccounts([...deduped, ...pendingOnes]);
    }

    const fileIds = new Set(deduped.map(a => a.id));

    // 3. 新增 / token 变化 / 字段同步
    for (const acc of deduped) {
        const rt = runtimes.get(acc.id);
        if (!rt) {
            try {
                await startAccount(acc);
                logger.sys(`[wechat][${acc.name || acc.id}] 热加载：已开始监听`);
            } catch (e: any) {
                logger.error('wechat', `[${acc.name || acc.id}] 热加载启动失败: ${fmtErr(e)}`);
            }
            continue;
        }

        if (rt.account.botToken !== acc.botToken) {
            logger.sys(`[wechat][${acc.name || acc.id}] token 变化，重启监听`);
            stopAccount(acc.id);
            try {
                await startAccount(acc);
            } catch (e: any) {
                logger.error('wechat', `[${acc.name || acc.id}] 重启失败: ${fmtErr(e)}`);
            }
            continue;
        }

        // 同步可变字段
        rt.account.name = acc.name;
        rt.account.cursor = acc.cursor;
        rt.account.targetUserId = acc.targetUserId;
        rt.account.contextToken = acc.contextToken;
        rt.account.subscriptions = acc.subscriptions;
    }

    // 4. 已删除账号 -> 停止
    for (const id of Array.from(runtimes.keys())) {
        if (!fileIds.has(id)) {
            stopAccount(id);
            logger.sys(`[wechat] 热加载：账号已移除 ${id}`);
        }
    }
}

// ---------------- 初始化 ----------------

export async function initWechat(): Promise<void> {
    const accounts = loadAccounts();

    const active = accounts.filter(a => !a.pending);

    if (active.length === 0) {
        logger.sys('[wechat] 未配置任何可用的微信账号，请运行: ./manage.sh login');
    } else {
        for (const acc of active) {
            try {
                await startAccount(acc);
            } catch (e: any) {
                logger.error('wechat', `[${acc.name || acc.id}] 启动失败: ${fmtErr(e)}`);
            }
        }
        logger.sys(`[wechat] 已启动 ${runtimes.size}/${active.length} 个账号`);
    }

    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
        syncAccounts().catch(e => logger.error('wechat', `syncAccounts: ${fmtErr(e)}`));
    }, 10_000);
    logger.sys('[wechat] 账号热加载已启用（10s 一次）');
}

// ---------------- 推送 ----------------
export async function pushToWechat(
    tag: string,
    anchor: Anchor,
    fileName: string,
    timeTag: string,
    text: string
): Promise<void> {
    // 1. 永远先写 outbox（离线也不丢）
    const entry =
        JSON.stringify({
            tag,
            anchor: anchor.name,
            file: fileName,
            time: timeTag,
            text: text.replace(/\s+/g, ' ').trim(),
        }) + '\n';
    fs.appendFileSync(OUTBOX_FILE, entry, 'utf-8');

    // 2. 遍历在线账号，按主播名过滤
    const tasks: Promise<void>[] = [];
    for (const rt of runtimes.values()) {
        const {account, client} = rt;
        if (!account.targetUserId || !account.contextToken) continue;

        const subs = account.subscriptions ?? [];
        // 空 = 全部；非空 = 只推订阅的主播
        if (subs.length > 0 && !subs.includes(anchor.name)) continue;

        const msg = `【${tag}】【${anchor.name}】${timeTag}\n${text.slice(0, 1500)} \n\n✨回复任意消息接受后续咨询`;
        tasks.push(
            (async () => {
                try {
                    await client.sendText({
                        toUserId: account.targetUserId,
                        text: msg,
                        contextToken: account.contextToken,
                    });
                    logger.info('wechat', `[${account.name || account.id}][${tag}] 已推送: ${anchor.name} / ${fileName}`);
                } catch (e: any) {
                    logger.error('wechat', `[${account.name || account.id}][${tag}] 推送失败: ${fmtErr(e)}`);
                }
            })()
        );
    }
    await Promise.allSettled(tasks);
}

// ---------------- 导出工具 ----------------

export function getWxClient() {
    return runtimes;
}

export function getAccounts(): WechatAccount[] {
    return loadAccounts();
}

/** 更新某账号订阅（按 id 或 name 匹配） */
export function updateSubscriptions(who: string, subs: string[]): boolean {
    const all = loadAccounts();
    const acc = all.find(a => a.id === who || a.name === who);
    if (!acc) return false;
    acc.subscriptions = subs;
    saveAccounts(all);
    const rt = runtimes.get(acc.id);
    if (rt) rt.account.subscriptions = subs;
    return true;
}

/** 停止所有轮询与热加载（供优雅退出调用） */
export function stopWechat(): void {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
    for (const rt of runtimes.values()) {
        if (rt.pollTimer) clearInterval(rt.pollTimer);
    }
    runtimes.clear();
}