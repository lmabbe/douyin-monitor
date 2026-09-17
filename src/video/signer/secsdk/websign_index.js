/**
 * x-secsdk-web-signature 生成入口（Node 补环境）
 *
 * 加载顺序（与真实页面一致）：
 *   1. websign_env.js  —— 补浏览器环境 + 预置 secsdk 会话密钥
 *   2. secsdk_runtime.js —— 建立 window.use / SDKRuntime / 策略表
 *   3. bdms_1.0.1.19_fix.js —— 通过 coreLoader 注册 webSignUrl（JSVMP 字节码）
 *
 * 用法：
 *   const { web_sign } = require('./websign_index.js');
 *   const signedUrl = web_sign('https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/?...');
 * 返回带 uifid + timestamp + x-secsdk-web-signature 的完整 URL。
 */
const path = require('path');
const fs = require('fs');

const LIB = __dirname;

// 1. 补环境
const env = require(path.join(LIB, 'websign_env.js'));
const window = env.window;

// 2. 加载 secsdk_runtime（建立 window.use / SDKRuntime）
function loadInGlobal(file) {
    const code = fs.readFileSync(path.join(LIB, file), 'utf8');
    // 用间接 eval 在全局作用域执行，使其能访问我们补的 window/document 等
    const runner = new Function('window', 'document', 'navigator', 'location',
        'localStorage', 'sessionStorage', 'screen', 'performance', 'self', 'globalThis',
        code + '\n//# sourceURL=' + file);
    runner.call(window, window, env.document, window.navigator, window.location,
        window.localStorage, window.sessionStorage, window.screen, window.performance, window, window);
}

let loadErr = null;
try {
    loadInGlobal('secsdk_runtime.js');
} catch (e) {
    loadErr = 'secsdk_runtime: ' + (e && e.stack || e);
}

// 注：webSignUrl 由 secsdk_runtime.js 自身注册（无需加载 bdms）。
// bdms 仅 a_bogus 用，且在本补环境会卡死初始化，故不加载。

// secsdk_runtime 加载完毕后恢复 process，供调用方（CLI/子进程）输出
if (env.restoreProcess) env.restoreProcess();

function web_sign(url) {
    if (!window.use) throw new Error('window.use 未定义（secsdk_runtime 未加载成功）: ' + loadErr);
    const f = window.use('webSignUrl');
    if (typeof f !== 'function') throw new Error('webSignUrl 未注册（bdms 未加载/coreLoader 未触发）: ' + loadErr);
    return f(url);
}

function diagnose() {
    return {
        hasUse: typeof window.use,
        hasSDKRuntime: typeof window.SDKRuntime,
        moduleKeys: window.SDKRuntime ? Object.keys(window.SDKRuntime.module || {}) : [],
        globalKeys: window.SDKRuntime ? Object.keys(window.SDKRuntime.global || {}) : [],
        hasBdms: typeof window.bdms,
        webSignUrlType: (function () { try { return typeof window.use('webSignUrl'); } catch (e) { return 'ERR:' + e; } })(),
        loadErr: loadErr,
    };
}

module.exports = { web_sign: web_sign, diagnose: diagnose, window: window };

// 命令行自检
if (require.main === module) {
    env.restoreProcess();
    console.log(JSON.stringify(diagnose(), null, 2));
    try {
        const u = 'https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=MS4wLjABAAAAuWb40KLM29J4hu2eXKN5GSZ8k3hdsZHRQ6CUNiW4OAY&count=18&max_cursor=0&min_cursor=0&device_platform=webapp&aid=6383';
        const signed = web_sign(u);
        console.log('\n=== web_sign 输出 ===');
        console.log(signed);
        const m = String(signed).match(/x-secsdk-web-signature=([a-f0-9]+)/);
        console.log('\nx-secsdk-web-signature:', m ? m[1] : '(未生成)');
    } catch (e) {
        console.log('\nweb_sign 调用失败:', e && e.stack || e);
    }
}
