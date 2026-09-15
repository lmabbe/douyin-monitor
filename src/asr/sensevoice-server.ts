import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';

const execFileAsync = promisify(execFile);

// ========== 远程 ASR 服务 ==========
const ASR_SERVER_URL = process.env.ASR_SERVER_URL || '';
const ASR_SERVER_TIMEOUT = Number(process.env.ASR_SERVER_TIMEOUT || '120') * 1000;

// ========== 本地 SenseVoice 兜底 ==========
const SENSEVOICE_DIR = process.env.SENSEVOICE_DIR ||
  path.join(os.homedir(), 'sensevoice');
const SENSEVOICE_BIN = process.env.SENSEVOICE_BIN ||
  path.join(SENSEVOICE_DIR, 'llama-funasr-sensevoice');
const SENSEVOICE_MODEL = process.env.SENSEVOICE_MODEL ||
  path.join(SENSEVOICE_DIR, 'gguf/sensevoice-small-q8.gguf');
const SENSEVOICE_VAD = process.env.SENSEVOICE_VAD ||
  path.join(SENSEVOICE_DIR, 'gguf/fsmn-vad.gguf');

if (ASR_SERVER_URL) {
  console.log(`[asr] 远程服务: ${ASR_SERVER_URL}`);
} else {
  console.log(`[asr] 未配置 ASR_SERVER_URL，只用本地 SenseVoice`);
}
console.log(`[asr] 本地兜底: ${SENSEVOICE_BIN}`);

/**
 * 把 m4a 转成 16kHz 单声道 WAV
 */
async function convertToWav(inputM4a: string): Promise<string> {
  const wavPath = inputM4a.replace(/\.m4a$/i, '.asr.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputM4a,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wavPath,
  ]);
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
 * 本地 SenseVoice（原 sensevoice.ts 的逻辑）
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
  const { stdout } = await execFileAsync('grun', [
    '-f', SENSEVOICE_BIN,
    '-m', SENSEVOICE_MODEL,
    '--vad', SENSEVOICE_VAD,
    '--srt',
    '-a', wavPath,
  ], { maxBuffer: 64 * 1024 * 1024 });
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
        console.log(`[asr] 远程成功 (${((Date.now()-t0)/1000).toFixed(1)}s, ${text.length}字)`);
        return text;
      } catch (e: any) {
        console.warn(`[asr] 远程失败，切换本地: ${e.message}`);
      }
    }

    // 2. 本地兜底
    console.log(`[asr] 使用本地 SenseVoice ...`);
    const t0 = Date.now();
    const text = await transcribeLocal(wavPath);
    console.log(`[asr] 本地成功 (${((Date.now()-t0)/1000).toFixed(1)}s, ${text.length}字)`);
    return text;

  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}
