import 'dotenv/config';
import OpenAI from 'openai';

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
        content: [
          '你是中文语音识别后处理助手。',
          '输入可能包含同音字错误、缺标点、口语碎片。',
          '请修正识别错误、补全标点、去掉无意义重复。',
          '不要总结、改写、补充原音频没有的内容。',
          '直接输出修正后的文本，不要任何解释。',
        ].join('\n'),
      },
      { role: 'user', content: rawText },
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
        content:
          '你是财经直播内容分析助手。请从文字稿提取：\n' +
          '1. 核心观点\n2. 宏观判断\n3. 对 A 股 / 美股 / 黄金 / 美元 / 人民币 的判断\n' +
          '4. 关键数据\n5. 风险因素\n输出 markdown。',
      },
      { role: 'user', content: fullText.slice(0, 60_000) },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 8192,
  });

  return completion.choices[0]?.message?.content || '';
}
