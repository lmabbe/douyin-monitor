const path = require('path');
const { execFileSync } = require('child_process');

global.navigator = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  vendorSubs: {}
};
global.window = {
  innerWidth: 1920, innerHeight: 1080, outerWidth: 1920, outerHeight: 1080,
  screen: { availWidth: 1920, availHeight: 1080, width: 1920, height: 1080, sizeWidth: 1920, sizeHeight: 1080 },
  onwheelx: {}
};
global.programVersion = 'release';

const { makeABogus } = require('./utils.cjs');
const LIB = __dirname;

function signUrl(params, api) {
  api = api || '/aweme/v1/web/aweme/post/';
  const a_bogus = makeABogus(params, 0);
  const urlWithBogus = 'https://www.douyin.com' + api + '?' + params + '&a_bogus=' + encodeURIComponent(a_bogus);
  const runner = `const ws=require(${JSON.stringify(path.join(LIB, 'secsdk', 'websign_index.js'))});process.stdout.write(ws.web_sign(${JSON.stringify(urlWithBogus)}));`;
  const out = execFileSync('node', ['-e', runner], { maxBuffer: 10 * 1024 * 1024 }).toString();
  return out.trim();
}

module.exports = { signUrl };
