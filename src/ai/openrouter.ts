import 'dotenv/config';
import OpenAI from 'openai';
import {getCleanTranscriptPrompt, getSummarizeSegmentPrompt, getSummarizeSessionPrompt} from './prompts.js';

const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY!,
    baseURL: 'https://openrouter.ai/api/v1',
    timeout: 120_000,
    maxRetries: 1,
    defaultHeaders: {
        // OpenRouter 要求这两个 header，用于统计和排名
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/local/douyin-live',
        'X-Title': process.env.OPENROUTER_TITLE || 'douyin-live-monitor',
    },
});

const MODEL = process.env.OPENROUTER_MODEL || 'inclusionai/ling-3.0-flash-sante:free'; // __AI_MODEL_LOG__
console.log(`[ai] openrouter 模型: ${MODEL}`);

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
 * ASR 纠错
 */
export async function cleanTranscript(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';

    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getCleanTranscriptPrompt(),
            },
            {role: 'user', content: rawText},
        ],
        temperature: 0.1,
        max_tokens: 2048,
    });

    const text = extractText(completion.choices[0]?.message);
    return text || rawText;
}

/**
 * 切片级结构化总结
 */
export async function summarizeSegment(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';
    console.log(`[ai] openrouter summarizeSegment (输入 ${rawText.length} 字)`);

    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getSummarizeSegmentPrompt(),
            },
            {role: 'user', content: rawText},
        ],
        temperature: 0.3,
        max_tokens: 1024,
    });

    const raw = extractText(completion.choices[0]?.message);
    const text = stripThinking(raw);
    return text || '（本段无实质观点）';
}

/**
 * 整场直播完整总结
 */
export async function summarizeSession(fullText: string): Promise<string> {
    console.log(`[ai] openrouter summarizeSession (输入 ${fullText.length} 字)`);
    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getSummarizeSessionPrompt(),
            },
            {role: 'user', content: fullText.slice(0, 60_000)},
        ],
        temperature: 0.3,
        max_tokens: 4096,
    });

    return extractText(completion.choices[0]?.message);
}
