import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';

const execFileAsync = promisify(execFile);

// ========== 工具：展开 ~ ==========
// dotenv 不会展开 ~，这里手动处理
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ========== 远程 ASR 服务 ==========
const ASR_SERVER_URL = process.env.ASR_SERVER_URL || '';
const ASR_SERVER_TIMEOUT = Number(process.env.ASR_SERVER_TIMEOUT || '120') * 1000;

// ========== 本地 SenseVoice 兜底 ==========
const SENSEVOICE_DIR = expandHome(
  process.env.SENSEVOICE_DIR || path.join(os.homedir(), 'sensevoice')
);
const SENSEVOICE_BIN = expandHome(
  process.env.SENSEVOICE_BIN ||
    path.join(SENSEVOICE_DIR, 'llama-funasr-sensevoice')
);
const SENSEVOICE_MODEL = expandHome(
  process.env.SENSEVOICE_MODEL ||
    path.join(SENSEVOICE_DIR, 'gguf/sensevoice-small-q8.gguf')
);
const SENSEVOICE_VAD = expandHome(
  process.env.SENSEVOICE_VAD ||
    path.join(SENSEVOICE_DIR, 'gguf/fsmn-vad.gguf')
);

// grun：Termux 用 glibc-runner，其他系统直接跑
const GRUN_BIN = process.env.GRUN_BIN || 'grun';
const USE_GRUN = process.env.USE_GRUN !== 'false'; // 默认 true（Termux）

// ffmpeg：允许覆盖
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

// ========== 启动时打印配置 ==========
if (ASR_SERVER_URL) {
  console.log(`[asr] 远程服务: ${ASR_SERVER_URL}`);
} else {
  console.log(`[asr] 未配置 ASR_SERVER_URL，只用本地 SenseVoice`);
}
console.log(`[asr] 本地模式: ${USE_GRUN ? `grun (${GRUN_BIN})` : '直接执行'}`);
console.log(`[asr] 本地二进制: ${SENSEVOICE_BIN}`);
console.log(`[asr] 本地模型: ${SENSEVOICE_MODEL}`);
console.log(`[asr] 本地 VAD: ${SENSEVOICE_VAD}`);
console.log(`[asr] ffmpeg: ${FFMPEG_BIN}`);

// ========== 启动时检查本地文件（仅警告，不阻断） ==========
if (!ASR_SERVER_URL) {
  if (!fs.existsSync(SENSEVOICE_BIN)) {
    console.warn(`[asr] ⚠️ 二进制不存在: ${SENSEVOICE_BIN}`);
  }
  if (!fs.existsSync(SENSEVOICE_MODEL)) {
    console.warn(`[asr] ⚠️ 模型不存在: ${SENSEVOICE_MODEL}`);
  }
  if (!fs.existsSync(SENSEVOICE_VAD)) {
    console.warn(`[asr] ⚠️ VAD 不存在: ${SENSEVOICE_VAD}`);
  }
}

/**
 * 把 m4a 转成 16kHz 单声道 WAV。
 * 常规失败时用 +genpts+igndts / ignore_err 尝试修复未封口的分片 MP4。
 */
async function convertToWav(inputM4a: string): Promise<string> {
  const wavPath = inputM4a.replace(/\.m4a$/i, '.asr.wav');
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputM4a,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);
  } catch (e: any) {
    console.warn(`[asr] 常规转码失败，尝试修复模式: ${e.message?.slice(0, 120)}`);
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', inputM4a,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);
  }
  return wavPath;
}

/**
 * 请求远程 ASR 服务
 */
async function transcribeRemote(wavPath: string): Promise<string> {
  const buffer = fs.readFileSync(wavPath);

  // 用原生 FormData（Node 18+ 内置）
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');

  const resp = await axios.post(`${ASR_SERVER_URL}/asr`, form, {
    headers: {
      // axios 会为 FormData 自动设置 boundary，不要手动设 Content-Type
    },
    timeout: ASR_SERVER_TIMEOUT,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (resp.data && typeof resp.data.text === 'string') {
    return resp.data.text.trim();
  }
  throw new Error(`远程返回格式异常: ${JSON.stringify(resp.data).slice(0, 200)}`);
}

/**
 * 本地 SenseVoice（对齐 sensevoice.ts 的逻辑）
 */
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

async function transcribeLocal(wavPath: string): Promise<string> {
  let stdout: string;

  if (USE_GRUN) {
    // Termux：用 grun -f 加载 glibc 二进制
    const r = await execFileAsync(GRUN_BIN, [
      '-f', SENSEVOICE_BIN,
      '-m', SENSEVOICE_MODEL,
      '--vad', SENSEVOICE_VAD,
      '--srt',
      '-a', wavPath,
    ], { maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
  } else {
    // 其他系统：直接执行
    const r = await execFileAsync(SENSEVOICE_BIN, [
      '-m', SENSEVOICE_MODEL,
      '--vad', SENSEVOICE_VAD,
      '--srt',
      '-a', wavPath,
    ], { maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
  }

  return parseSrt(stdout);
}

/**
 * 对外接口：先远程，失败 fallback 本地
 */
export async function transcribe(audioPath: string): Promise<string> {
  const wavPath = await convertToWav(audioPath);

  try {
    // 1. 远程优先
    if (ASR_SERVER_URL) {
      try {
        console.log(`[asr] 请求远程 ${ASR_SERVER_URL}/asr ...`);
        const t0 = Date.now();
        const text = await transcribeRemote(wavPath);
        console.log(`[asr] 远程成功 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length}字)`);
        return text;
      } catch (e: any) {
        console.warn(`[asr] 远程失败，切换本地: ${e.message}`);
      }
    }

    // 2. 本地兜底
    console.log(`[asr] 使用本地 SenseVoice ...`);
    const t0 = Date.now();
    const text = await transcribeLocal(wavPath);
    console.log(`[asr] 本地成功 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length}字)`);
    return text;

  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}