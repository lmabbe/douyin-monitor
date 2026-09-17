import 'dotenv/config';
import OpenAI from 'openai';
import {getCleanTranscriptPrompt, getSummarizeSegmentPrompt, getSummarizeSessionPrompt} from './prompts.js';

const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY!,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    timeout: 120_000,
});

const MODEL = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash-0731'; // __AI_MODEL_LOG__
console.log(`[ai] nvidia 模型: ${MODEL}`);

/**
 * 对单个 ASR 切片文本做纠错
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
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 4096,
    });

    return (completion.choices[0]?.message?.content || rawText).trim();
}

/**
 * 对整场直播做总结（第二阶段用）
 */
export async function summarizeSession(fullText: string): Promise<string> {
    console.log(`[ai] nvidia summarizeSession (输入 ${fullText.length} 字)`);
    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: getSummarizeSessionPrompt()
            },
            {role: 'user', content: fullText.slice(0, 60_000)},
        ],
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 8192,
    });

    return completion.choices[0]?.message?.content || '';
}
