import 'dotenv/config';
import OpenAI from 'openai';
import {getCleanTranscriptPrompt, getSummarizeSegmentPrompt, getSummarizeSessionPrompt} from './prompts.js';

// Hugging Face Inference Providers 提供 OpenAI 兼容的 chat completions 端点
// 路由地址见官方文档：https://router.huggingface.co/v1
const client = new OpenAI({
    apiKey: process.env.HF_TOKEN!,          // 用 HF_TOKEN，和 NVIDIA_API_KEY 分开
    baseURL: 'https://router.huggingface.co/v1',
    timeout: 120_000,
    maxRetries: 1,
});

// 你想用的模型，按 HF 上的实际模型 ID 填写
// 例如 deepseek-ai/DeepSeek-V4-Flash-0731，或 Qwen/Qwen3-32B
const MODEL = process.env.HF_MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';

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
