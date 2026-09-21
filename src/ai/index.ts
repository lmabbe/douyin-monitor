/**
 * AI 全局降级链
 *
 * 小结（summarizeSegment）和总结（summarizeSession）走不同链：
 *   小结：Gemini → Groq → 腾讯
 *   总结：Gemini → 腾讯   （Groq TPM 8000，跑不了几万字整场总结）
 */
import {logger} from '../logger.js';

type AiTask = 'cleanTranscript' | 'summarizeSegment' | 'summarizeSession';

interface Provider {
    name: string;
    label?: string;
    load: () => Promise<Record<AiTask, (text: string) => Promise<string>>>;
}

// ========== 各 provider 定义（只定义一次，被不同链引用）==========
const P = {
    gemini: {
        name: 'gemini',
        label: 'Gemini',
        load: () => import('./gemini.js'),
    } as Provider,
    groq: {
        name: 'groq',
        label: 'Groq',
        load: () => import('./groq.js'),
    } as Provider,
    tencent: {
        name: 'tencent',
        label: '腾讯',
        load: () => import('./tencent.js'),
    } as Provider,
};

// ========== 两条链 ==========
const CHAIN_SEGMENT: Provider[] = [P.gemini, P.groq, P.tencent];
const CHAIN_SESSION: Provider[] = [P.gemini, P.tencent];

// cleanTranscript 跟小结一样（输入量级类似）
const CHAIN_CLEAN: Provider[] = [P.gemini, P.groq, P.tencent];

/** 按任务类型取链 */
function getChain(task: AiTask): Provider[] {
    if (task === 'summarizeSession') return CHAIN_SESSION;
    return CHAIN_SEGMENT;
}

// ========== 核心：按链尝试 ==========
async function runChain(
    task: AiTask,
    text: string,
    label: string
): Promise<string> {
    if (!text || !text.trim()) return '';

    const chain = getChain(task);
    let lastErr: any;
    const tried: string[] = [];

    for (const provider of chain) {
        try {
            const mod = await provider.load();
            const fn = mod[task];
            if (typeof fn !== 'function') {
                throw new Error(`provider ${provider.name} 未导出 ${task}`);
            }
            const t0 = Date.now();
            const result = await fn(text);
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            if (tried.length > 0) {
                logger.info(
                    'ai',
                    `[${label}] ${provider.name} 成功（前 ${tried.length} 个失败: ${tried.join(',')}, ${dt}s）`
                );
            } else {
                logger.info('ai', `[${label}] ${provider.name} 成功 (${dt}s)`);
            }
            return result;
        } catch (e: any) {
            tried.push(provider.name);
            lastErr = e;
            logger.warn(
                'ai',
                `[${label}] ${provider.name} 失败: ${e?.message?.slice(0, 120) || e}`
            );
        }
    }

    throw new Error(
        `[${label}] 降级链全部失败 (${tried.join(' → ')}): ${lastErr?.message || 'unknown'}`
    );
}

// ========== 对外接口 ==========

/** ASR 纠错 */
export async function cleanTranscript(rawText: string): Promise<string> {
    return runChain('cleanTranscript', rawText, 'clean');
}

/** 切片级/单视频结构化总结（小结） */
export async function summarizeSegment(rawText: string): Promise<string> {
    return runChain('summarizeSegment', rawText, 'segment');
}

/** 整场直播完整总结（总结） */
export async function summarizeSession(fullText: string): Promise<string> {
    return runChain('summarizeSession', fullText, 'session');
}

// ========== 启动横幅用：分别格式化两条链 ==========
function fmtChain(chain: Provider[]): string {
    return chain.map((p) => p.label || p.name).join(' → ');
}

export function formatAiChain(task?: AiTask): string {
    if (task === 'summarizeSession') return fmtChain(CHAIN_SESSION);
    if (task === 'summarizeSegment') return fmtChain(CHAIN_SEGMENT);
    if (task === 'cleanTranscript') return fmtChain(CHAIN_CLEAN);
    // 不传 task 时给个总览
    return `小结 ${fmtChain(CHAIN_SEGMENT)} / 总结 ${fmtChain(CHAIN_SESSION)}`;
}