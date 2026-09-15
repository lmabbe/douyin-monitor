import 'dotenv/config';
import OpenAI from 'openai';

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
        content: [
          '你是中文语音识别（ASR）后处理专家。',
          '输入：一段由 whisper 模型识别的直播音频文字，可能包含：',
          '  - 同音字错误（如"鬼迷"实际是"规模"、"拉底"实际是"拉低"）',
          '  - 缺失的标点',
          '  - 口语碎片、重复词',
          '  - 无意义的连读错误',
          '',
          '任务：逐句检查并修正，输出更通顺、更符合上下文逻辑的文本。',
          '规则：',
          '  1. 只修正识别错误，不要增删原意',
          '  2. 根据上下文推断正确词汇（财经、直播、娱乐场景的常用词优先）',
          '  3. 补全标点，去掉明显的口吃重复',
          '  4. 如果整段已经是正确的中文，原样返回',
          '  5. 直接输出修正后的文本，不要加任何解释、前缀、markdown',
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
  console.log(`[ai] nvidia summarizeSession (输入 ${fullText.length} 字)`);
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          '你是财经直播内容分析助手。请从以下直播文字稿中提取：\n' +
          '1. 核心观点（3-5 条）\n' +
          '2. 宏观判断\n' +
          '3. 对 A 股 / 美股 / 黄金 / 美元 / 人民币 的判断\n' +
          '4. 关键数据\n' +
          '5. 风险因素\n' +
          '输出 markdown 格式。',
      },
      { role: 'user', content: fullText.slice(0, 60_000) },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 8192,
  });

  return completion.choices[0]?.message?.content || '';
}
