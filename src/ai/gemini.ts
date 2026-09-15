import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.GEMINI_API_KEY!;
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3-flash')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// 记录当天哪些模型不可用
const DISABLED_FILE = path.join(process.cwd(), '.gemini-disabled.json');

interface DisabledRecord {
  date: string;           // YYYY-MM-DD
  models: string[];       // 当天不可用的模型
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
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
    console.log(`[gemini] 模型 ${model} 今日禁用（明天重置）`);
  }
}

function isDisabled(model: string): boolean {
  const rec = loadDisabled();
  return rec.models.includes(model);
}

function getAvailableModels(): string[] {
  return MODELS.filter(m => !isDisabled(m));
}

console.log(`[ai] gemini 候选模型: ${MODELS.join(', ')}`);
console.log(`[ai] 今日可用: ${getAvailableModels().join(', ') || '（无）'}`);

/**
 * 从 OpenAI 兼容响应中提取文本
 */
function extractText(msg: any): string {
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
  return '';
}

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
    throw new Error('Gemini 今日所有模型都不可用');
  }

  let lastErr: any;
  for (const model of available) {
    const client = new OpenAI({
      apiKey: API_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: 60_000,
      maxRetries: 0,
    });

    try {
      console.log(`[gemini] 尝试 ${label} 模型: ${model}`);
      const t0 = Date.now();
      const result = await fn(model, client);
      console.log(`[gemini] ✅ ${model} 成功 (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      return result;
    } catch (e: any) {
      const status = e.response?.status || e.status;
      const msg = e.message || String(e);

      console.warn(`[gemini] ❌ ${model} 失败: HTTP ${status || '?'} ${msg.slice(0, 100)}`);

      // 404 / 429 / 403 / quota 相关 → 今天禁用这个模型
      if (status === 404 || status === 429 || status === 403 || /quota|not found|no longer available|permission/i.test(msg)) {
        markDisabled(model);
      }

      lastErr = e;
    }
  }
  throw new Error(`所有 Gemini 模型都失败: ${lastErr?.message}`);
}

/**
 * 纠错（备用）
 */
export async function cleanTranscript(rawText: string): Promise<string> {
  if (!rawText.trim()) return '';

  const result = await tryModels('cleanTranscript', async (model, client) => {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: '你是中文语音识别后处理助手。修正同音错字、补全标点、去掉重复。直接输出修正后的文本，不要解释。',
        },
        { role: 'user', content: rawText },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    });
    return extractText(completion.choices[0]?.message) || rawText;
  });

  return result;
}

/**
 * 切片级结构化总结
 */
export async function summarizeSegment(rawText: string): Promise<string> {
  if (!rawText.trim()) return '';

  return tryModels('summarizeSegment', async (model, client) => {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: [
            '你是 A 股财经直播内容分析师。',
            '从这段直播文本中提炼核心观点，输出结构化总结。',
            '',
            '【格式】只输出有内容的字段：',
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
            '1. 只提炼主播明确说出的判断',
            '2. 去掉寒暄、关注、点赞、粉丝等运营话术',
            '3. 去掉重复啰嗦的口语',
            '4. 如果整段没有实质观点，输出"（本段无实质观点）"',
            '5. 【极其重要】禁止输出任何思考过程、英文说明',
            '6. 【极其重要】直接给结论',
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
  });
}

/**
 * 整场直播完整总结
 */
export async function summarizeSession(fullText: string): Promise<string> {
  return tryModels('summarizeSession', async (model, client) => {
    const completion = await client.chat.completions.create({
      model,
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
  });
}
