import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import {
    getCleanTranscriptPrompt,
    getSummarizeSegmentPrompt,
    getSummarizeSessionPrompt,
} from './prompts.js';

const API_KEY = process.env.GROQ_API_KEY!;
const MODELS = (process.env.GROQ_MODEL || 'openai/gpt-oss-20b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

// 记录当天哪些模型不可用
const DISABLED_FILE = path.join(process.cwd(), '.groq-disabled.json');

interface DisabledRecord {
    date: string;      // YYYY-MM-DD
    models: string[];  // 当天不可用的模型
}

function today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadDisabled(): DisabledRecord {
    try {
        const data = JSON.parse(fs.readFileSync(DISABLED_FILE, 'utf-8'));
        // 如果不是今天的记录，重置
        if (data.date !== today()) {
            return { date: today(), models: [] };
        }
        return data;
    } catch {
        return { date: today(), models: [] };
    }
}

function saveDisabled(rec: DisabledRecord) {
    try {
        fs.writeFileSync(DISABLED_FILE, JSON.stringify(rec, null, 2));
    } catch {}
}

function markDisabled(model: string) {
    const rec = loadDisabled();
    if (!rec.models.includes(model)) {
        rec.models.push(model);
        saveDisabled(rec);
        console.log(`[groq] 模型 ${model} 今日禁用（明天重置）`);
    }
}

function isDisabled(model: string): boolean {
    const rec = loadDisabled();
    return rec.models.includes(model);
}

function getAvailableModels(): string[] {
    return MODELS.filter((m) => !isDisabled(m));
}

console.log(`[ai] groq 候选模型: ${MODELS.join(', ')}`);
console.log(`[ai] groq 今日可用: ${getAvailableModels().join(', ') || '（无）'}`);

/**
 * 从 OpenAI 兼容响应中提取文本
 */
function extractText(msg: any): string {
    if (!msg) return '';
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
    if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return msg.reasoning.trim();
    return '';
}

/**
 * 去掉模型可能输出的思维链（英文思考、分析过程）
 */
function stripThinking(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    const out: string[] = [];
    let inThinking = true;
    for (const line of lines) {
        const t = line.trim();
        if (inThinking) {
            if (/^[*#\-]|^[\u4e00-\u9fa5]/.test(t) && !/^(We |Let's|Need|The |I |Input|Output|We need|Hmm|Actually|So |But |Yes|No )/.test(t)) {
                inThinking = false;
            } else {
                continue;
            }
        }
        out.push(line);
    }
    return out.join('\n').trim();
}

/**
 * 逐个尝试可用模型，第一个成功的返回
 * 所有模型都失败则抛错
 */
async function tryModels<T>(
    label: string,
    fn: (model: string, client: OpenAI) => Promise<T>
): Promise<T> {
    const available = getAvailableModels();
    if (available.length === 0) {
        throw new Error('Groq 今日所有模型都不可用');
    }

    let lastErr: any;
    for (const model of available) {
        const client = new OpenAI({
            apiKey: API_KEY,
            baseURL: BASE_URL,
            timeout: 120_000,
            maxRetries: 0,
        });

        try {
            console.log(`[groq] 尝试 ${label} 模型: ${model}`);
            const t0 = Date.now();
            const result = await fn(model, client);
            console.log(`[groq] ✅ ${model} 成功 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            return result;
        } catch (e: any) {
            const status = e.response?.status || e.status;
            const msg = e.message || String(e);

            console.warn(`[groq] ❌ ${model} 失败: HTTP ${status || '?'} ${msg.slice(0, 100)}`);

            // 404 / 429 / 403 / quota / 模型不存在 → 今天禁用这个模型
            if (
                status === 404 ||
                status === 429 ||
                status === 403 ||
                /quota|rate limit|not found|no longer available|permission|decommission|model/i.test(msg)
            ) {
                markDisabled(model);
            }

            lastErr = e;
        }
    }
    throw new Error(`所有 Groq 模型都失败: ${lastErr?.message}`);
}

/** 纠错（备用） */
export async function cleanTranscript(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';

    return tryModels('cleanTranscript', async (model, client) => {
        const completion = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: getCleanTranscriptPrompt() },
                { role: 'user', content: rawText },
            ],
            temperature: 0.1,
            max_tokens: 2048,
        });
        const text = extractText(completion.choices[0]?.message);
        return text || rawText;
    });
}

/** 切片级结构化总结 */
export async function summarizeSegment(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';

    return tryModels('summarizeSegment', async (model, client) => {
        const completion = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: getSummarizeSegmentPrompt() },
                { role: 'user', content: rawText },
            ],
            temperature: 0.3,
            max_tokens: 1024,
        });

        const raw = extractText(completion.choices[0]?.message);
        const text = stripThinking(raw);
        return text || '（本段无实质观点）';
    });
}

/** 整场直播完整总结 */
export async function summarizeSession(fullText: string): Promise<string> {
    return tryModels('summarizeSession', async (model, client) => {
        const completion = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: getSummarizeSessionPrompt() },
                { role: 'user', content: fullText.slice(0, 60_000) },
            ],
            temperature: 0.3,
            max_tokens: 4096,
        });
        return extractText(completion.choices[0]?.message);
    });
}