/**
 * 模拟直播结束，验证：
 * 1. LIVE ended 是否触发
 * 2. generateAndPushSummary 是否能找到 transcript
 * 3. AI 总结是否成功
 * 4. 微信推送是否发出
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const RECORDS_DIR = path.join(process.cwd(), 'records');
const ANCHOR = process.argv[2] || 'test';

console.log(`=== 测试直播结束流程: ${ANCHOR} ===\n`);

// 1. 找 transcript
function findLatestTranscript(anchorName: string): string | null {
  const anchorDir = path.join(RECORDS_DIR, anchorName, 'live');
  if (!fs.existsSync(anchorDir)) {
    console.log(`❌ 目录不存在: ${anchorDir}`);
    return null;
  }
  const dirs = fs.readdirSync(anchorDir).filter(d => /^\d{12}$/.test(d)).sort();
  console.log(`📁 找到 ${dirs.length} 个直播目录: ${dirs.join(', ')}`);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const p = path.join(anchorDir, dirs[i], 'transcript.txt');
    if (fs.existsSync(p)) return p;
    const p2 = path.join(anchorDir, dirs[i], 'live_transcript.txt');
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

const transcriptPath = findLatestTranscript(ANCHOR);
if (!transcriptPath) {
  console.log(`❌ 没找到 transcript`);
  process.exit(1);
}

console.log(`✅ transcript: ${transcriptPath}`);
const fullText = fs.readFileSync(transcriptPath, 'utf-8');
console.log(`📝 文本长度: ${fullText.length} 字`);
console.log(`📝 最后 100 字: ${fullText.slice(-100)}\n`);

if (fullText.length < 100) {
  console.log(`❌ 文本太短 (< 100 字)，会跳过总结`);
  process.exit(1);
}

// 2. 调 AI 总结
console.log(`=== 调用 AI 总结 ===`);
const t0 = Date.now();
let summary = '';
try {
  const { summarizeSession } = await import('./src/ai/gemini.js');
  summary = await summarizeSession(fullText);
  console.log(`✅ Gemini 成功 (${((Date.now()-t0)/1000).toFixed(1)}s)`);
} catch (e: any) {
  console.log(`⚠️ Gemini 失败: ${e.message}`);
  try {
    const { summarizeSession } = await import('./src/ai/tencent.js');
    summary = await summarizeSession(fullText);
    console.log(`✅ 腾讯成功 (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  } catch (e2: any) {
    console.log(`❌ 所有 AI 失败: ${e2.message}`);
    process.exit(1);
  }
}

console.log(`📄 总结长度: ${summary.length} 字`);
console.log(`📄 总结前 200 字:\n${summary.slice(0, 200)}\n`);

// 3. 写 summary.md
const summaryPath = path.join(path.dirname(transcriptPath), 'summary.md');
fs.writeFileSync(summaryPath, summary, 'utf-8');
console.log(`✅ 已写入: ${summaryPath}`);

// 4. 检查微信推送函数
console.log(`\n=== 微信推送格式 ===`);
const timeTag = new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log(`将会推送的格式：`);
console.log(`【LIVE】【${ANCHOR}】【总结】${timeTag}`);
console.log(summary.slice(0, 200));

console.log(`\n=== 测试完成 ===`);
console.log(`\n要真正推送微信，需要运行主程序并触发 LIVE ended。`);
console.log(`或者，把生成的 summary.md 手动发到微信。`);
