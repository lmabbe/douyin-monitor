import 'dotenv/config';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import path from 'path';

const API_KEY = process.env.GEMINI_API_KEY!;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
const CHUNK_SIZE = 3200;
const SEND_INTERVAL_MS = 10;

export async function transcribeFile(audioPath: string): Promise<string> {
  console.log(`[gemini-live-file] 处理: ${path.basename(audioPath)}`);
  const pcmBuffer = await extractPcm(audioPath);
  console.log(`[gemini-live-file] PCM: ${(pcmBuffer.length / 1024 / 1024).toFixed(1)} MB, 约 ${(pcmBuffer.length / (16000 * 2)).toFixed(1)} 秒`);
  return await sendToGemini(pcmBuffer);
}

function extractPcm(audioPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-ar', '16000', '-ac', '1',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s && !s.includes('Connection timed out')) console.error(`[ffmpeg] ${s}`);
    });
    ff.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg 退出 code=${code}`));
    });
    ff.on('error', reject);
  });
}

function sendToGemini(pcm: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const finalTexts: string[] = [];
    let chunkIndex = 0;
    let finished = false;
    let sentAll = false;

    const timeout = setTimeout(() => finish(), 300_000);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(finalTexts.join(''));
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: { languageCodes: [], mode: 'SMART' },
        },
      }));
    });

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.setupComplete) { sendNextChunk(); return; }
      const content = msg.serverContent;
      if (!content) return;
      if (content.inputTranscription) {
        const t = content.inputTranscription.text;
        if (t) finalTexts.push(t);
      }
      if (content.turnComplete && sentAll) { console.log('[gemini-live-file] turnComplete'); setTimeout(finish, 500); }
    });

    ws.on('error', (e) => {
      if (!finished) { finished = true; clearTimeout(timeout); reject(e); }
    });

    ws.on('close', () => { if (!finished) finish(); });

    function sendNextChunk() {
      if (chunkIndex * CHUNK_SIZE >= pcm.length) {
        sentAll = true;
        console.log(`[gemini-live-file] 音频发送完毕，等待最终结果...`);
        ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        // 等 turnComplete 或 60 秒兜底
        setTimeout(finish, 60000);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, pcm.length);
      const piece = pcm.subarray(start, end);
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: piece.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
        },
      }));
      chunkIndex++;
      setTimeout(sendNextChunk, SEND_INTERVAL_MS);
    }
  });
}
