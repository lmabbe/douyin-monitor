import axios from 'axios';

// ========== 配置区 ==========
const WEB_RID = '187610110185';
const TTWID = '';
const A_BOGUS = '';

const ENTER_API = 'https://live.douyin.com/webcast/room/web/enter/';

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

async function main() {
  console.log('=== 抖音直播流验证 Demo ===\n');
  console.log(`目标直播间: ${WEB_RID}\n`);

  // 1. 获取 ttwid
  let ttwid = TTWID;
  if (!ttwid) {
    console.log('[1] 获取 ttwid...');
    const pageResp = await axios.get(`https://live.douyin.com/${WEB_RID}`, {
      headers: { 'User-Agent': UA },
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 15000,
    });
    console.log(`[1] 页面 HTTP: ${pageResp.status}`);
    const cookies = pageResp.headers['set-cookie'];
    if (cookies) {
      const c = cookies.find((x: string) => x.startsWith('ttwid='));
      if (c) {
        ttwid = c.split(';')[0];
        console.log(`[1] ✅ ttwid: ${ttwid.slice(0, 60)}...`);
      }
    }
  } else {
    console.log('[1] ✅ 使用手动 ttwid');
  }

  // 2. 调 enter 接口
  console.log('\n[2] 调用 enter 接口...');

  const params: Record<string, string> = {
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '126.0.0.0',
    web_rid: WEB_RID,
    enter_from: 'web_live',
    is_need_double_stream: 'false',
  };
  if (A_BOGUS) params.a_bogus = A_BOGUS;

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Referer': `https://live.douyin.com/${WEB_RID}`,
  };
  if (ttwid) headers['Cookie'] = ttwid;

  const resp = await axios.get(ENTER_API, {
    params,
    headers,
    validateStatus: () => true,
    timeout: 15000,
  });

  console.log(`[2] HTTP: ${resp.status}`);
  const data = resp.data;

  // 3. 兼容两种结构：data.room 或 data.data[0]
  console.log('\n[3] 解析响应...');

  // 顶层状态
  if (data?.status_code !== undefined && data.status_code !== 0) {
    console.log(`[3] ⚠️ status_code=${data.status_code}`);
  }

  const inner = data?.data;
  let room: any = null;

  if (inner?.room) {
    room = inner.room;
    console.log('[3] 使用路径: data.room');
  } else if (Array.isArray(inner?.data) && inner.data.length > 0) {
    room = inner.data[0];
    console.log('[3] 使用路径: data.data[0]');
  }

  if (!room) {
    console.log('[3] ❌ 未找到 room');
    console.log('[3] data.data 字段:', Object.keys(inner || {}).join(', '));
    console.log(JSON.stringify(data, null, 2).slice(0, 800));
    return;
  }

  console.log(`[3] room.id_str   = ${room.id_str}`);
  console.log(`[3] room.status   = ${room.status}  (2=直播中, 4=已结束)`);
  console.log(`[3] room.title    = ${room.title || '(空)'}`);
  console.log(`[3] user_count_str= ${room.user_count_str}`);

  if (room.status !== 2) {
    console.log('\n[结果] ⚠️ 当前未开播');
    return;
  }

  // 4. 提取流地址
  console.log('\n[4] 提取流地址...');
  const streamUrl = room.stream_url;
  if (!streamUrl) {
    console.log('[4] ❌ 无 stream_url 字段');
    console.log('[4] room 字段:', Object.keys(room).join(', '));
    return;
  }

  console.log('[4] stream_url 字段:', Object.keys(streamUrl).join(', '));

  // HLS 优先（FFmpeg 音频录制最友好）
  const hls = streamUrl.hls_pull_url_map;
  if (hls && Object.keys(hls).length > 0) {
    const quality = hls.FULL_HD1 ? 'FULL_HD1' : (hls.HD1 ? 'HD1' : Object.keys(hls)[0]);
    const url = hls[quality];
    console.log(`[4] ✅ HLS 清晰度: ${Object.keys(hls).join(', ')}`);
    console.log(`\n[✅ 成功] 使用 ${quality}:\n${url}\n`);
    printFfmpegHint(url, 'm3u8');
    return;
  }

  // FLV 备选
  const flv = streamUrl.flv_pull_url;
  if (flv && Object.keys(flv).length > 0) {
    const quality = flv.FULL_HD1 ? 'FULL_HD1' : (flv.HD1 ? 'HD1' : Object.keys(flv)[0]);
    const url = flv[quality];
    console.log(`[4] ✅ FLV 清晰度: ${Object.keys(flv).join(', ')}`);
    console.log(`\n[✅ 成功] 使用 ${quality}:\n${url}\n`);
    printFfmpegHint(url, 'flv');
    return;
  }

  console.log('[4] ⚠️ 没有找到 hls 或 flv 字段');
  console.log(JSON.stringify(streamUrl, null, 2).slice(0, 1500));
}

function printFfmpegHint(url: string, fmt: string) {
  console.log('----- FFmpeg 验证命令 -----');
  console.log(`ffmpeg -i "${url}" -t 10 -vn -c:a copy test.${fmt === 'm3u8' ? 'm4a' : 'flv'}`);
  console.log('（拉 10 秒测试，如果成功说明流可用）\n');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.response) {
    console.log('HTTP', e.response.status);
    console.log(String(e.response.data).slice(0, 500));
  }
});
