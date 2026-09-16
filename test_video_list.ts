import 'dotenv/config';

const COOKIE = process.env.DOUYIN_COOKIE || '';
const VIDEO_URL = 'https://www.douyin.com/user/MS4wLjABAAAATiIJw83GyKKQNW77jgHThghQYKc8Vz8VGyBkc5DlCthRzwCtNrVghz4ZHLbUW-dV';

console.log('=== 查看麦麦吉视频列表 ===\n');

// 1. 检查 Cookie
console.log('[1] Cookie 长度:', COOKIE.length);
const badChars = [...COOKIE].map((ch, i) => ({ ch, i, code: ch.charCodeAt(0) })).filter(x => x.code > 127);
if (badChars.length > 0) {
  console.log('❌ Cookie 含非 ASCII 字符:');
  badChars.slice(0, 10).forEach(x => {
    console.log(`   位置 ${x.i} 字符 ${JSON.stringify(x.ch)} 码点 ${x.code}`);
  });
  process.exit(1);
} else {
  console.log('✅ Cookie 全 ASCII');
}

// 2. 检查 VIDEO_URL
console.log('\n[2] VIDEO_URL 长度:', VIDEO_URL.length);
const badUrl = [...VIDEO_URL].map((ch, i) => ({ ch, i, code: ch.charCodeAt(0) })).filter(x => x.code > 127);
if (badUrl.length > 0) {
  console.log('❌ VIDEO_URL 含非 ASCII 字符:');
  badUrl.forEach(x => console.log(`   位置 ${x.i} 字符 ${JSON.stringify(x.ch)} 码点 ${x.code}`));
} else {
  console.log('✅ VIDEO_URL 全 ASCII');
}

// 3. 尝试调 polydl
console.log('\n[3] 调用 polydl...');
try {
  const { getSecUserId, DouyinHandler } = await import('polydl');

  const secUserId = await getSecUserId(VIDEO_URL);
  console.log('✅ sec_user_id:', secUserId);

  const handler = new DouyinHandler({ cookie: COOKIE });
  console.log('✅ handler 创建成功');

  let count = 0;
  for await (const postFilter of handler.fetchUserPostVideos(secUserId, { maxCounts: 5 })) {
    const list = postFilter.toAwemeDataList();
    for (const a of list) {
      count++;
      const id = a.awemeId || a.aweme_id;
      const ct = a.createTime || a.create_time;
      const desc = (a.desc || '').slice(0, 30);
      console.log(`  ${count}. ${id}  ${ct}  ${desc}`);
    }
  }
  console.log(`\n✅ 共 ${count} 个视频`);

} catch (e: any) {
  console.error('❌ 失败:', e.message);
  console.error(e.stack);
}