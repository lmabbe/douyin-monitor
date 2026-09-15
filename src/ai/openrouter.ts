import 'dotenv/config';
import OpenAI from 'openai';

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
        content: [
          '你是 A 股财经直播的语音识别纠错助手。',
          '输入是 whisper 模型的原始输出，存在大量同音错字，必须修正。',
          '',
          '【必须修正】',
          '1. 同音错字：MSCC→MSCI、券伤→券商、林寿→人寿、佳希→加息',
          '2. 补全标点',
          '3. 去掉口语碎片重复',
          '',
          '【不能做】不要总结、不要改写、不要补充原文没有的内容。',
          '直接输出修正后的纯文本，不要解释。',
        ].join('\n'),
      },
      { role: 'user', content: rawText },
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
        content: [
          '你是 A 股财经直播内容分析师。',
          '输入是一段 2 分钟直播的语音识别文本（可能有错字，忽略它们）。',
          '',
          '【任务】',
          '从这段文本中提炼主播表达的核心观点，输出结构化总结。',
          '',
          '【输出格式】只输出有内容的字段：',
          '',
          '**板块**：xxx',
          '- 观点1',
          '- 观点2',
          '',
          '**大盘/指数**：xxx',
          '- 观点1',
          '',
          '**风险/其他**：xxx',
          '- 观点1',
          '',
          '【规则】',
          '1. 只提炼主播明确说出的判断，不要推测',
          '2. 去掉寒暄、关注、点赞、粉丝等运营话术',
          '3. 去掉重复啰嗦的口语',
          '4. 如果整段没有实质观点，输出"（本段无实质观点）"',
          '5. 不要"主播说..."，直接给观点本身',
          '6. 【极其重要】禁止输出任何思考过程、英文说明、分析过程',
          '7. 【极其重要】直接给出结论，不要引导语',
        ].join('\n'),
      },
      { role: 'user', content: rawText },
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
        content:
          '你是财经直播内容分析助手。请从文字稿提取：\n' +
          '1. 核心观点（3-5 条）\n2. 宏观判断\n' +
          '3. 对 A 股 / 美股 / 黄金 / 美元 / 人民币 的判断\n' +
          '4. 关键数据\n5. 风险因素\n输出 markdown。',
      },
      { role: 'user', content: fullText.slice(0, 60_000) },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  });

  return extractText(completion.choices[0]?.message);
}
