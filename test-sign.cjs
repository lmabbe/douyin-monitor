#!/usr/bin/env node
/**
 * 独立签名测试脚本
 * 流程完全照抄旧 final.cjs：a_bogus → 拼 URL → secsdk 追加签名 → curl 请求
 * 配置读 config/websign_env.json
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const ENV_JSON = path.join(ROOT, 'config', 'websign_env.json');

// ---- 0. 读环境 ----
if (!fs.existsSync(ENV_JSON)) {
  console.error('❌ 找不到配置文件:', ENV_JSON);
  process.exit(1);
}
const liveEnv = JSON.parse(fs.readFileSync(ENV_JSON, 'utf8'));
const COOKIE = liveEnv.cookie;
const UA = liveEnv.ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

if (!COOKIE || COOKIE === '粘贴完整Cookie') {
  console.error('❌ config/websign_env.json 里的 cookie 是占位符，请填真实值');
  process.exit(1);
}

console.log('[test] cookie 长度:', COOKIE.length);
console.log('[test] ua:', UA.slice(0, 60) + '...');

// ---- 1. 参数（照抄 test-video-debug.ts） ----
const params =
  'device_platform=webapp&aid=6383&channel=channel_pc_web'
  + '&sec_user_id=MS4wLjABAAAAuNn-nvAZ9qSMnElriH-A27sdla-O2ITaRMYPyP5WCziPEmLktuIH0zazDmNMnu_f'
  + '&max_cursor=0&count=20&publish_video_strategy_type=2'
  + '&update_version_code=170400&pc_client_type=1'
  + '&version_code=290100&version_name=29.1.0'
  + '&cookie_enabled=true&screen_width=1920&screen_height=1080'
  + '&browser_language=zh-CN&browser_platform=MacIntel'
  + '&browser_name=Chrome&browser_version=137.0.0.0'
  + '&browser_online=true&engine_name=Blink&engine_version=137.0.0.0'
  + '&os_name=Mac&os_version=10.15.7&cpu_core_num=8&device_memory=8'
  + '&platform=PC&downlink=10&effective_type=4g&round_trip_time=50'
  + '&webid=7686350976520947215';

// ---- 2. 调 signer 生成签名 URL ----
console.log('\n[test] === 步骤 1: 调 signUrl() ===');
let signedUrl;
try {
  const { signUrl } = require('./src/video/signer/signer.cjs');
  const t0 = Date.now();
  signedUrl = signUrl(params, '/aweme/v1/web/aweme/post/');
  console.log('[test] ✅ signUrl 完成 (' + ((Date.now() - t0) / 1000).toFixed(2) + 's)');
  console.log('[test] URL 长度:', signedUrl.length);
} catch (e) {
  console.error('❌ signUrl 失败:', e && e.stack || e);
  process.exit(1);
}

// ---- 3. 检查 URL 里有没有 a_bogus + x-secsdk-web-signature ----
const hasABogus = /a_bogus=/.test(signedUrl);
const hasSec = /x-secsdk-web-signature=/.test(signedUrl);
console.log('[test] a_bogus:', hasABogus ? '✅' : '❌');
console.log('[test] x-secsdk-web-signature:', hasSec ? '✅' : '❌');

if (!hasABogus) {
  console.error('❌ 缺 a_bogus，签名链路不对');
  process.exit(1);
}

// ---- 4. curl 发请求 ----
console.log('\n[test] === 步骤 2: curl 请求 ===');
const cmd = `curl -s '${signedUrl}' `
  + `-H 'User-Agent: ${UA}' `
  + `-H 'Cookie: ${COOKIE}' `
  + `-H 'Referer: https://www.douyin.com/' `
  + `--compressed`;

let resp;
try {
  const t0 = Date.now();
  resp = execFileSync('bash', ['-c', cmd], { maxBuffer: 50 * 1024 * 1024 }).toString();
  console.log('[test] ✅ curl 返回 (' + ((Date.now() - t0) / 1000).toFixed(2) + 's, ' + resp.length + ' 字节)');
} catch (e) {
  console.error('❌ curl 失败:', e.message);
  process.exit(1);
}

// ---- 5. 解析校验 ----
console.log('\n[test] === 步骤 3: 校验返回 ===');
if (!resp.trim()) {
  console.error('❌ 返回为空');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(resp);
} catch (e) {
  console.error('❌ 返回不是 JSON，前 500 字:');
  console.error(resp.slice(0, 500));
  process.exit(1);
}

console.log('[test] status_code:', data.status_code);
console.log('[test] status_msg:', data.status_msg || '(空)');

if (data.status_code === 0 && Array.isArray(data.aweme_list) && data.aweme_list.length > 0) {
  console.log('\n✅✅✅ 测试通过！拉到', data.aweme_list.length, '个视频');
  console.log('[test] 第一条:', data.aweme_list[0].aweme_id, data.aweme_list[0].desc?.slice(0, 30) || '(无标题)');
  process.exit(0);
} else if (data.status_code === 8) {
  console.error('\n❌ 测试失败：风控拦截 (status_code=8)');
  console.error('  可能原因：cookie 过期 / 签名算法失效 / IP 被限');
  console.error('  完整返回前 800 字:');
  console.error(resp.slice(0, 800));
  process.exit(1);
} else {
  console.error('\n❌ 测试失败：status_code=' + data.status_code);
  console.error('  完整返回前 800 字:');
  console.error(resp.slice(0, 800));
  process.exit(1);
}