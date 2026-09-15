import 'dotenv/config';
import OpenAI from 'openai';

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
        content: [
          '你是 A 股财经直播的语音识别纠错助手。',
          '输入是 whisper 模型的原始输出，存在大量同音错字，必须修正。',
          '',
          '【必须修正的错误类型】',
          '1. 同音错字：MSCC→MSCI、券伤→券商、林寿→人寿、佳希→加息、光仙→光纤、变盘→变盘',
          '2. 缺标点：补全逗号、句号，长句拆短',
          '3. 口语碎片：去掉"好吧"、"对吧"、"是吧"等过度重复（保留首尾各一次）',
          '4. 无意义重复：连续重复的短语合并',
          '',
          '【不能做的事】',
          '- 不要总结、不要概括、不要换同义词',
          '- 不要添加原文没有的内容',
          '- 不要解释、不要加 markdown、不要加引号',
          '',
          '【输出格式】',
          '直接输出修正后的纯文本，一段话，不加任何前后缀。',
          '不要输出思考过程。',
        ].join('\n'),
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
        content:
          '你是财经直播内容分析助手。请从文字稿提取：\n' +
          '1. 核心观点（3-5 条）\n2. 宏观判断\n' +
          '3. 对 A 股 / 美股 / 黄金 / 美元 / 人民币 的判断\n' +
          '4. 关键数据\n5. 风险因素\n输出 markdown。',
      },
      { role: 'user', content: fullText.slice(0, 60_000) },
    ],
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
        content: [
          '你是 A 股财经直播内容分析师。',
          '输入是一段 2 分钟直播的语音识别文本（可能有些错字，忽略它们）。',
          '',
          '【任务】',
          '从这段文本中提炼主播表达的核心观点，输出结构化总结。',
          '',
          '【输出格式】',
          '如果这段内容有观点，按以下格式输出（只输出有内容的字段）：',
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
          '2. 去掉寒暄、谢谢、关注、点赞、粉丝等运营话术',
          '3. 去掉重复啰嗦的口语',
          '4. 如果整段没有任何实质观点（全是闲聊、喊粉丝、念弹幕），输出"（本段无实质观点）"',
          '5. 不要总结"主播说了什么"，直接给出观点本身',
          '6. 输出纯文本，可用 **加粗** 做小标题',
          '7. 【极其重要】禁止输出任何思考过程、分析过程、英文说明',
          '8. 【极其重要】直接给出结论，不要"让我们分析一下"之类的引导语',
          '9. 【极其重要】如果发现自己想说"We need"、"Let me"、"我们需要"这类话，立刻停止，直接从结构化的观点开始',
        ].join('\n'),
      },
      { role: 'user', content: rawText },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 1024,
  });

  return extractText(completion.choices[0]?.message) || '（本段无实质观点）';
}
