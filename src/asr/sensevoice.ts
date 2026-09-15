import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

const SENSEVOICE_DIR = process.env.SENSEVOICE_DIR ||
  path.join(os.homedir(), 'sensevoice');
const SENSEVOICE_BIN = process.env.SENSEVOICE_BIN ||
  path.join(SENSEVOICE_DIR, 'llama-funasr-sensevoice');
const SENSEVOICE_MODEL = process.env.SENSEVOICE_MODEL ||
  path.join(SENSEVOICE_DIR, 'gguf/sensevoice-small-q8.gguf');
const SENSEVOICE_VAD = process.env.SENSEVOICE_VAD ||
  path.join(SENSEVOICE_DIR, 'gguf/fsmn-vad.gguf');

console.log(`[sensevoice] bin: ${SENSEVOICE_BIN}`);
console.log(`[sensevoice] model: ${SENSEVOICE_MODEL}`);
console.log(`[sensevoice] vad: ${SENSEVOICE_VAD}`);

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
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', audioPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    // 2) SenseVoice --srt（stdout 捕获）
    const { stdout } = await execFileAsync('grun', [
      '-f', SENSEVOICE_BIN,
      '-m', SENSEVOICE_MODEL,
      '--vad', SENSEVOICE_VAD,
      '--srt',
      '-a', wavPath,
    ], { maxBuffer: 64 * 1024 * 1024 });

    // 3) 解析 SRT
    return parseSrt(stdout);

  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}
