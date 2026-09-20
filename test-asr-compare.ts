/**
 * ASR 对比测试：Groq Whisper vs 本地 SenseVoice
 *
 * 用法：
 *   npx tsx test-asr-compare.ts <音频文件路径>
 *   npx tsx test-asr-compare.ts records/李一恩/live/202609151303/seg_001.m4a
 *
 * 会依次用两家转写，打印结果 + 耗时 + 字数，方便肉眼对比。
 *
 * 环境：需要 .env 里有 GROQ_API_KEY
 *       本地 SenseVoice 路径沿用 SENSEVOICE_* 环境变量
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);

// ========== 参数 ==========
const audioPath = process.argv[2];
if (!audioPath) {
  console.error('用法: npx tsx test-asr-compare.ts <音频文件路径>');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error('❌ 文件不存在:', audioPath);
  process.exit(1);
}

// ========== Groq 配置 ==========
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

// ========== 本地 SenseVoice 配置 ==========
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
const SENSEVOICE_DIR = expandHome(
  process.env.SENSEVOICE_DIR || path.join(os.homedir(), 'sensevoice')
);
const SENSEVOICE_BIN = expandHome(
  process.env.SENSEVOICE_BIN || path.join(SENSEVOICE_DIR, 'llama-funasr-sensevoice')
);
const SENSEVOICE_MODEL = expandHome(
  process.env.SENSEVOICE_MODEL || path.join(SENSEVOICE_DIR, 'gguf/sensevoice-small-q8.gguf')
);
const SENSEVOICE_VAD = expandHome(
  process.env.SENSEVOICE_VAD || path.join(SENSEVOICE_DIR, 'gguf/fsmn-vad.gguf')
);
const GRUN_BIN = process.env.GRUN_BIN || 'grun';
const USE_GRUN = process.env.USE_GRUN !== 'false';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

// ========== 工具 ==========
function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

function fileSizeMB(p: string): string {
  return (fs.statSync(p).size / 1024 / 1024).toFixed(2) + ' MB';
}

/** 音频时长（秒），用 ffprobe */
async function getDurationSec(p: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      p,
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ========== Groq Whisper ==========
async function transcribeGroq(p: string): Promise<{ text: string; ms: number }> {
  if (!GROQ_API_KEY) throw new Error('缺少 GROQ_API_KEY');

  const client = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: GROQ_BASE_URL,
    timeout: 180_000,
    maxRetries: 0,
  });

  const t0 = Date.now();
  const resp = await client.audio.transcriptions.create({
    model: GROQ_WHISPER_MODEL,
    file: fs.createReadStream(p),
    language: 'zh',
    response_format: 'text',
  });
  const ms = Date.now() - t0;

  const text =
    typeof resp === 'string'
      ? resp
      : (resp as any)?.text || '';
  return { text: String(text).trim(), ms };
}

// ========== 本地 SenseVoice ==========
function parseSrt(srtContent: string): string {
  const lines = srtContent.split('\n');
  const texts: string[] = [];
  let inText = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { inText = false; continue; }
    if (/^\d+$/.test(line)) { inText = false; continue; }
    if (/^\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(line)) { inText = true; continue; }
    if (inText) texts.push(line);
  }
  return texts.join('').replace(/\s+/g, ' ').trim();
}

async function transcribeSenseVoice(p: string): Promise<{ text: string; ms: number }> {
  const base = p.replace(/\.m4a$/i, '');
  const wavPath = `${base}.test-asr.wav`;

  try {
    // 转 wav 16k mono
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', p,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    const t0 = Date.now();
    let stdout: string;
    if (USE_GRUN) {
      const r = await execFileAsync(GRUN_BIN, [
        '-f', SENSEVOICE_BIN,
        '-m', SENSEVOICE_MODEL,
        '--vad', SENSEVOICE_VAD,
        '--srt',
        '-a', wavPath,
      ], { maxBuffer: 64 * 1024 * 1024 });
      stdout = r.stdout;
    } else {
      const r = await execFileAsync(SENSEVOICE_BIN, [
        '-m', SENSEVOICE_MODEL,
        '--vad', SENSEVOICE_VAD,
        '--srt',
        '-a', wavPath,
      ], { maxBuffer: 64 * 1024 * 1024 });
      stdout = r.stdout;
    }
    const ms = Date.now() - t0;

    return { text: parseSrt(stdout), ms };
  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}

// ========== 主流程 ==========
async function main() {
  console.log('=== ASR 对比测试 ===');
  console.log('文件:', audioPath);
  console.log('大小:', fileSizeMB(audioPath));

  const dur = await getDurationSec(audioPath);
  if (dur) console.log('时长:', dur.toFixed(1) + 's');

  console.log('\n配置:');
  console.log('  Groq model:', GROQ_WHISPER_MODEL, '@', GROQ_BASE_URL);
  console.log('  SenseVoice bin:', SENSEVOICE_BIN);
  console.log('  SenseVoice model:', SENSEVOICE_MODEL);
  console.log('  SenseVoice mode:', USE_GRUN ? `grun (${GRUN_BIN})` : '直接执行');

  // ---------- Groq ----------
  console.log('\n========== [1/2] Groq Whisper ==========');
  let groqText = '';
  let groqMs = 0;
  try {
    const r = await transcribeGroq(audioPath);
    groqText = r.text;
    groqMs = r.ms;
    console.log(`✅ 成功 (${fmtSec(groqMs)}, ${groqText.length} 字)`);
    if (dur) console.log(`   速度: ${(dur / (groqMs / 1000)).toFixed(1)}x 实时`);
  } catch (e: any) {
    console.log(`❌ 失败: HTTP ${e.status || e.response?.status || '?'} ${e.message?.slice(0, 200)}`);
  }

  // ---------- SenseVoice ----------
  console.log('\n========== [2/2] 本地 SenseVoice ==========');
  let svText = '';
  let svMs = 0;
  try {
    const r = await transcribeSenseVoice(audioPath);
    svText = r.text;
    svMs = r.ms;
    console.log(`✅ 成功 (${fmtSec(svMs)}, ${svText.length} 字)`);
    if (dur) console.log(`   速度: ${(dur / (svMs / 1000)).toFixed(1)}x 实时`);
  } catch (e: any) {
    console.log(`❌ 失败: ${e.message?.slice(0, 300)}`);
  }

  // ---------- 结果对比 ----------
  console.log('\n========== 结果对比 ==========');
  console.log('\n--- Groq Whisper ---');
  console.log(groqText || '(无)');
  console.log('\n--- 本地 SenseVoice ---');
  console.log(svText || '(无)');

  console.log('\n========== 统计 ==========');
  console.log(`Groq:        ${groqMs ? fmtSec(groqMs) : '失败'}  ${groqText.length} 字`);
  console.log(`SenseVoice:  ${svMs ? fmtSec(svMs) : '失败'}  ${svText.length} 字`);

  // 可选：把两边结果写到文件，方便 diff
  const outDir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  if (groqText) {
    const f = path.join(outDir, `${base}.groq.txt`);
    fs.writeFileSync(f, groqText, 'utf-8');
    console.log(`\nGroq 结果已写入: ${f}`);
  }
  if (svText) {
    const f = path.join(outDir, `${base}.sensevoice.txt`);
    fs.writeFileSync(f, svText, 'utf-8');
    console.log(`SenseVoice 结果已写入: ${f}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});