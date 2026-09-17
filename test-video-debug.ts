import 'dotenv/config';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
const { signUrl } = require('./src/video/signer/signer.cjs');

const cookie = process.env.DOUYIN_COOKIE || '';
console.log('cookie 长度:', cookie.length);

const params = 'device_platform=webapp&aid=6383&channel=channel_pc_web'
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

const url = signUrl(params, '/aweme/v1/web/aweme/post/');
console.log('signed URL 长度:', url.length);

const cmd = ['curl', '-s', '-i', url,
  '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  '-H', `Cookie: ${cookie}`,
  '-H', 'Referer: https://www.douyin.com/',
  '--compressed'];

const out = execFileSync('curl', cmd.slice(1), { maxBuffer: 20 * 1024 * 1024 }).toString();
console.log('=== curl 输出前 1500 字 ===');
console.log(out.slice(0, 1500));
