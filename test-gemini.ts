/**
 * Gemini 提示词测试脚本
 *
 * 用法：
 *   npx tsx test-gemini.ts              # 全部测试
 *   npx tsx test-gemini.ts segment      # 只测 summarizeSegment
 *   npx tsx test-gemini.ts session      # 只测 summarizeSession
 *   npx tsx test-gemini.ts clean        # 只测 cleanTranscript
 *
 * 环境：需要 .env 里有 GEMINI_API_KEY 和 GEMINI_MODEL
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// ========== 配置 ==========
const API_KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error('❌ 缺少 GEMINI_API_KEY，请在 .env 里配');
  process.exit(1);
}

// ========== 加载 prompts.json ==========
const PROMPTS_FILE = path.join(process.cwd(), 'config', 'prompts.json');
if (!fs.existsSync(PROMPTS_FILE)) {
  console.error('❌ 找不到', PROMPTS_FILE);
  process.exit(1);
}
const prompts = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8'));

// ========== 测试样本 ==========
// 一段模拟的直播文字稿（带同音错字，模拟真实 ASR 输出）
const SAMPLE_RAW = `然后最新消息呢就是我们会在23号到24号之间去访问丑丑那这也是一个大事啊为期了两年多的贸易之间的这个不平衡到底现在能不能有新的进展啊我们在这里会重点为大家跟踪但不管怎么说这是在11月中期特选举之前一个非常好的信号它现在应该是不敢轻举妄动的那回到今天中午我们跟大家说今天全天中午那时候科双50一定不能追因为今天中午那一刻科双50它是在出货的今天下午要回踩30线大家可以看到科创50今天正好是下午回彩三十十线又拉回但是我们说了中线如果你想持股到国庆之后暂时也不用动啊除非你是做超短线的那我在这里也想问一下大家中午更喜欢我们去公司就是有那个中国尊那个背景去播还是喜欢我在家那种跟大家闲聊一两播但是晚上的直播场景我们是不会换的这一点我要征求一下大家的意见请大家给我一个意见搭在评论区`;

// 一段较长的文字稿（模拟整场直播，用于 summarizeSession）
const SAMPLE_LONG = SAMPLE_RAW;

// ========== 调用 Gemini ==========
async function callGemini(systemPrompt: string, userText: string): Promise<string> {
  const client = new OpenAI({
    apiKey: API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    timeout: 60_000,
    maxRetries: 0,
  });

  let lastErr: any;
  for (const model of MODELS) {
    try {
      console.log(`  尝试模型: ${model} ...`);
      const t0 = Date.now();
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const text = completion.choices[0]?.message?.content || '';
      console.log(`  ✅ ${model} 成功 (${dt}s)`);
      console.log(`  ✅ ${model} 成功 (${text})`);
      return text;
    } catch (e: any) {
      const status = e.response?.status || e.status || '?';
      console.log(`  ❌ ${model} 失败: HTTP ${status} ${e.message?.slice(0, 100)}`);
      lastErr = e;
    }
  }
  throw new Error(`所有模型都失败: ${lastErr?.message}`);
}

// ========== 各测试 ==========
async function testClean(): Promise<void> {
  console.log('\n========== 测试 cleanTranscript ==========');
  console.log('输入:');
  console.log(SAMPLE_RAW);
  console.log('\n调用 Gemini...');
  const out = await callGemini(prompts.cleanTranscript.system, SAMPLE_RAW);
  console.log('\n输出:');
  console.log(out);
}

async function testSegment(): Promise<void> {
  console.log('\n========== 测试 summarizeSegment ==========');
  console.log('输入:');
  console.log(SAMPLE_RAW);
  console.log('\n调用 Gemini...');
  const out = await callGemini(prompts.summarizeSegment.system, SAMPLE_RAW);
  console.log('\n输出:');
  console.log(out);
}

async function testSession(): Promise<void> {
  console.log('\n========== 测试 summarizeSession ==========');
  console.log('输入:');
  console.log(SAMPLE_LONG);
  console.log('\n调用 Gemini...');
  const out = await callGemini(prompts.summarizeSession.system, SAMPLE_LONG);
  console.log('\n输出:');
  console.log(out);
}

// ========== 入口 ==========
async function main(): Promise<void> {
  console.log('=== Gemini 提示词测试 ===');
  console.log('API Key:', API_KEY!.slice(0, 8) + '...' + API_KEY!.slice(-4));
  console.log('模型:', MODELS.join(', '));
  console.log('提示词文件:', PROMPTS_FILE);

  const which = process.argv[2] || 'all';

  if (which === 'all' || which === 'clean') await testClean();
  if (which === 'all' || which === 'segment') await testSegment();
  if (which === 'all' || which === 'session') await testSession();

  console.log('\n=== 测试完成 ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});