/**
 * AI 提示词加载器
 *
 * 设计：
 *   - 提示词统一放在 config/prompts.json，不硬编码在代码里
 *   - 首次读文件后缓存，避免每次调用都读盘
 *   - 提供 reloadPrompts()，配合 ./manage.sh reload 热重载
 *
 * 用法：
 *   import { getSummarizeSegmentPrompt } from './prompts.js';
 *   const sys = getSummarizeSegmentPrompt();
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 用 import.meta.url 定位项目根，不依赖 process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_FILE = path.join(ROOT, 'config', 'prompts.json');

interface PromptsConfig {
  cleanTranscript: { system: string };
  summarizeSegment: { system: string };
  summarizeSession: { system: string };
}

// 缓存：首次读盘后存这里，reloadPrompts() 清空
let cache: PromptsConfig | null = null;

/**
 * 加载 prompts.json（带缓存）
 * 文件缺失或格式错误时抛异常，让调用方看到明确错误
 */
function loadPrompts(): PromptsConfig {
  if (cache) return cache;

  if (!fs.existsSync(PROMPTS_FILE)) {
    throw new Error(`找不到提示词配置: ${PROMPTS_FILE}`);
  }

  const raw = fs.readFileSync(PROMPTS_FILE, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`config/prompts.json 不是合法 JSON: ${e.message}`);
  }

  // 校验必需字段
  const required = ['cleanTranscript', 'summarizeSegment', 'summarizeSession'];
  for (const k of required) {
    if (!parsed[k] || typeof parsed[k].system !== 'string' || !parsed[k].system.trim()) {
      throw new Error(`config/prompts.json 缺少字段 "${k}.system" 或为空`);
    }
  }

  cache = parsed as PromptsConfig;
  return cache;
}

/**
 * 清空缓存，下次调用会重新读盘
 * 配合 ./manage.sh reload（触发 .reload 信号）使用
 */
export function reloadPrompts(): void {
  cache = null;
}

/** ASR 纠错提示词 */
export function getCleanTranscriptPrompt(): string {
  return loadPrompts().cleanTranscript.system;
}

/** 切片级/单视频总结提示词 */
export function getSummarizeSegmentPrompt(): string {
  return loadPrompts().summarizeSegment.system;
}

/** 整场直播总结提示词 */
export function getSummarizeSessionPrompt(): string {
  return loadPrompts().summarizeSession.system;
}