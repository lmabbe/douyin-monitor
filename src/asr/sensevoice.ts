import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

// ========== 从 .env 读路径，带默认值 ==========
const SENSEVOICE_DIR = process.env.SENSEVOICE_DIR ||
    path.join(os.homedir(), 'sensevoice');
const SENSEVOICE_BIN = process.env.SENSEVOICE_BIN ||
    path.join(SENSEVOICE_DIR, 'llama-funasr-sensevoice');
const SENSEVOICE_MODEL = process.env.SENSEVOICE_MODEL ||
    path.join(SENSEVOICE_DIR, 'gguf/sensevoice-small-q8.gguf');
const SENSEVOICE_VAD = process.env.SENSEVOICE_VAD ||
    path.join(SENSEVOICE_DIR, 'gguf/fsmn-vad.gguf');

// grun：Termux 用 glibc-runner，其他系统直接跑
const GRUN_BIN = process.env.GRUN_BIN || 'grun';
const USE_GRUN = process.env.USE_GRUN !== 'false';  // 默认 true（Termux）

// ffmpeg：允许覆盖
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

// ========== 启动时打印路径 ==========
console.log(`[sensevoice] 模式: ${USE_GRUN ? 'grun (Termux)' : '直接执行'}`);
console.log(`[sensevoice] 二进制: ${SENSEVOICE_BIN}`);
console.log(`[sensevoice] 模型: ${SENSEVOICE_MODEL}`);
console.log(`[sensevoice] VAD: ${SENSEVOICE_VAD}`);

// ========== 启动时检查文件存在 ==========
let sensevoiceAvailable = true;
if (!fs.existsSync(SENSEVOICE_BIN)) {
  console.warn(`[sensevoice] ⚠️ 二进制不存在: ${SENSEVOICE_BIN}`);
  sensevoiceAvailable = false;
}
if (!fs.existsSync(SENSEVOICE_MODEL)) {
  console.warn(`[sensevoice] ⚠️ 模型不存在: ${SENSEVOICE_MODEL}`);
  sensevoiceAvailable = false;
}
if (!fs.existsSync(SENSEVOICE_VAD)) {
  console.warn(`[sensevoice] ⚠️ VAD 不存在: ${SENSEVOICE_VAD}`);
  sensevoiceAvailable = false;
}
if (sensevoiceAvailable) {
  console.log(`[sensevoice] ✅ 所有文件就绪`);
} else {
  console.warn(`[sensevoice] ❌ 配置不完整，本地 SenseVoice 会失败`);
}

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

export async function transcribe(audioPath: string): Promise<string> {
  const base = audioPath.replace(/\.m4a$/i, '');
  const wavPath = `${base}.asr.wav`;

  try {
    // 1) 转 wav 16k mono
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', audioPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    // 2) SenseVoice
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

    // 3) 解析 SRT
    return parseSrt(stdout);

  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}
