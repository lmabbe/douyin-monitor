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
const SAMPLE_RAW = `盘中应对来了。首先昨晚的一席会议呢给他打50分吧，总体对于后面的讲话还是偏鹰派的，但是也变相表示了它现在美联储还有独立性，并不是完全特的走狗，而且30年期收益率反而下降了三个基点。而且大家看啊昨晚的美股科技，它是非常有韧性的那回到今天呢上证指数虽然说是冲高回落，但是也正常。因为毕竟它昨天晚上不是这种加息落地。加上割派还是有一点点小小的呃利空因素在的。所以今天昨天的获利盘哎，在早上10点半之前走了一部分，创业板也是反弹到20压力线之后回落，所以在大家这里不用恐慌啊，今天就是获利盘出逃。那接下来我认为整体大方向的虽然轮动加快，但是格局还是震荡向上的，但不会那么顺利。所以现在我认为仓位依旧保持这个呃中成65到6成左右。然后在这个位置变相做题，那什么时候等待继续进场或者是可以冲的信号呢？就是我昨天跟大家说。科创50的5日线要上传10日线。这个月因为同源学院新开一直在筹备，所以想问一下大家，如果你们希望我以后中午11点到12点加播的话。可以在评论区打两个字加播。我遵循大家的意见，如果加播的话，从下周中午开始。`;

// 一段较长的文字稿（模拟整场直播，用于 summarizeSession）
const SAMPLE_LONG = `盘中应对来了。首先昨晚的一席会议呢给他打50分吧，总体对于后面的讲话还是偏鹰派的，但是也变相表示了它现在美联储还有独立性，并不是完全特的走狗，而且30年期收益率反而下降了三个基点。而且大家看啊昨晚的美股科技，它是非常有韧性的那回到今天呢上证指数虽然说是冲高回落，但是也正常。因为毕竟它昨天晚上不是这种加息落地。加上割派还是有一点点小小的呃利空因素在的。所以今天昨天的获利盘哎，在早上10点半之前走了一部分，创业板也是反弹到20压力线之后回落，所以在大家这里不用恐慌啊，今天就是获利盘出逃。那接下来我认为整体大方向的虽然轮动加快，但是格局还是震荡向上的，但不会那么顺利。所以现在我认为仓位依旧保持这个呃中成65到6成左右。然后在这个位置变相做题，那什么时候等待继续进场或者是可以冲的信号呢？就是我昨天跟大家说。科创50的5日线要上传10日线。这个月因为同源学院新开一直在筹备，所以想问一下大家，如果你们希望我以后中午11点到12点加播的话。可以在评论区打两个字加播。我遵循大家的意见，如果加播的话，从下周中午开始。`;

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