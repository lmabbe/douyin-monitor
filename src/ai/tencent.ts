import 'dotenv/config';
import OpenAI from 'openai';
import {getCleanTranscriptPrompt, getSummarizeSegmentPrompt, getSummarizeSessionPrompt} from './prompts.js';

const client = new OpenAI({
    apiKey: process.env.TENCENT_API_KEY!,
    baseURL: process.env.TENCENT_BASE_URL || 'https://tokenhub.tencentmaas.com/v1',
    timeout: 120_000,
    maxRetries: 1,
});

const MODEL = process.env.TENCENT_MODEL || 'deepseek/deepseek-flash'; // __AI_MODEL_LOG__
console.log(`[ai] tencent 模型: ${MODEL}`);

function extractText(msg: any): string {
    if (!msg) return '';
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
    if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return msg.reasoning.trim();
    return '';
}

/**
 * ASR 纠错：修正同音错字、补标点、去重复
 */
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
        // 找到第一个像正式输出的行（中文/加粗/短横线开头）
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

export async function cleanTranscript(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';

    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getCleanTranscriptPrompt(),
            },
            {
                role: 'user',
                content: rawText,
            },
        ],
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 2048,
    });

    const text = extractText(completion.choices[0]?.message);
    return text || rawText;
}

/**
 * 整场直播总结
 */
export async function summarizeSession(fullText: string): Promise<string> {
    console.log(`[ai] tencent summarizeSession (输入 ${fullText.length} 字)`);
    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getSummarizeSessionPrompt(),
            },
            {role: 'user', content: fullText},],
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 4096,
    });

    return extractText(completion.choices[0]?.message);
}


/**
 * 对单个切片做观点总结（不是纠错，是提炼观点）
 */
export async function summarizeSegment(rawText: string): Promise<string> {
    if (!rawText.trim()) return '';
    console.log(`[ai] tencent summarizeSegment (输入 ${rawText.length} 字)`);

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
        top_p: 0.9,
        max_tokens: 1024,
    });

    return extractText(completion.choices[0]?.message) || '（本段无实质观点）';
}
