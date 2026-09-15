import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN ||
  path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL ||
  path.join(os.homedir(), 'whisper.cpp/models/ggml-small.bin'); // __WHISPER_LOG__
console.log(`[whisper] 模型: ${WHISPER_MODEL}`);
const WHISPER_LIB = process.env.WHISPER_LIB ||
  path.join(os.homedir(), 'whisper.cpp/build/bin');

function envWithLib(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const cur = env.LD_LIBRARY_PATH || '';
  env.LD_LIBRARY_PATH = cur ? `${WHISPER_LIB}:${cur}` : WHISPER_LIB;
  return env;
}

/**
 * 对单个音频切片做 ASR
 * @param audioPath .m4a 文件绝对路径
 * @returns 识别出的纯文本
 */
export async function transcribe(audioPath: string): Promise<string> {
  const base = audioPath.replace(/\.m4a$/i, '');
  const wavPath = `${base}.asr.wav`;
  const outPrefix = `${base}.asr`;

  try {
    // 1) 转 wav 16k mono
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', audioPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    // 2) whisper-cli
    await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-l', 'zh',
      '--prompt', '以下是普通话的财经直播内容。',
      '-otxt',
      '-of', outPrefix,
      '-t', '2',
      '--no-prints',
    ], { env: envWithLib(), maxBuffer: 64 * 1024 * 1024 });

    // 3) 读取结果
    const txtPath = `${outPrefix}.txt`;
    if (!fs.existsSync(txtPath)) return '';
    const text = fs.readFileSync(txtPath, 'utf-8').trim();
    return text;

  } finally {
    // 清理中间文件（保留 txt 让用户可查，或者也删掉）
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}
