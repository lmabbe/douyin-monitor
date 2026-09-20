import 'dotenv/config';
import fs from 'fs';
import OpenAI from 'openai';

const API_KEY = process.env.GROQ_API_KEY || '';
const BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

// 多模型轮询，和 groq.ts 一样
const MODELS = (process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo,whisper-large-v3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.warn('[asr] ⚠️ 缺少 GROQ_API_KEY，Groq Whisper 不可用');
}

console.log(`[asr] groq whisper 候选模型: ${MODELS.join(', ')}`);

// 不同模型的文件大小上限（字节）
const MODEL_MAX_BYTES: Record<string, number> = {
  'whisper-large-v3': 25 * 1024 * 1024,
  'whisper-large-v3-turbo': 25 * 1024 * 1024,
};
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** 转写文件，逐个模型尝试 */
export async function transcribe(audioPath: string): Promise<string> {
  if (!API_KEY) throw new Error('GROQ_API_KEY 未配置');

  const stat = fs.statSync(audioPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

  let lastErr: any;
  for (const model of MODELS) {
    const limit = MODEL_MAX_BYTES[model] ?? DEFAULT_MAX_BYTES;
    if (stat.size > limit) {
      console.warn(
        `[asr] groq ${model} 跳过: 文件 ${sizeMB}MB 超过 ${(limit / 1024 / 1024).toFixed(0)}MB 上限`
      );
      lastErr = new Error(`文件过大 (${sizeMB}MB) 超过 ${model} 上限`);
      continue;
    }

    const client = new OpenAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      timeout: 180_000,
      maxRetries: 0,
    });

    try {
      console.log(`[asr] groq 尝试 ${model} ... (${sizeMB}MB)`);
      const t0 = Date.now();
      const resp = await client.audio.transcriptions.create({
        model,
        file: fs.createReadStream(audioPath),
        language: 'zh',
        response_format: 'text',
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const text =
        typeof resp === 'string' ? resp : (resp as any)?.text || '';
      const trimmed = String(text).trim();
      console.log(`[asr] groq ✅ ${model} 成功 (${dt}s, ${trimmed.length}字)`);
      return trimmed;
    } catch (e: any) {
      const status = e.response?.status || e.status || '?';
      console.warn(
        `[asr] groq ❌ ${model} 失败: HTTP ${status} ${e.message?.slice(0, 120)}`
      );
      lastErr = e;
    }
  }
  throw new Error(`所有 Groq Whisper 模型都失败: ${lastErr?.message || 'unknown'}`);
}