const fs = require('fs');
const file = 'src/index.ts';
let c = fs.readFileSync(file, 'utf-8');

const oldStart = '  // ========== 配置热重载 ==========';
const oldEnd = '  // ========== /配置热重载 ==========';

const startIdx = c.indexOf(oldStart);
const endIdx = c.indexOf(oldEnd);
if (startIdx < 0 || endIdx < 0) {
  console.error('[!] 未找到热重载块');
  process.exit(1);
}

const newBlock = `  // ========== 配置热重载（信号文件触发） ==========
  const RELOAD_SIGNAL = path.join(process.cwd(), '.reload');
  let reloading = false;

  setInterval(() => {
    if (reloading) return;
    if (!fs.existsSync(RELOAD_SIGNAL)) return;
    try { fs.unlinkSync(RELOAD_SIGNAL); } catch {}
    reloading = true;

    try {
      logger.sys('[RELOAD] 检测到 .reload 信号，重新加载 anchors.json...');
      const newAnchors = loadAnchors();
      const newNames = new Set(newAnchors.map(a => a.name));

      for (const [name, rt] of runtimes.entries()) {
        if (!newNames.has(name)) {
          logger.sys(\`[RELOAD] 移除主播: \${name}\`);
          rt.recorder?.stop(name);
          rt.streamRecorder?.stop(name);
          runtimes.delete(name);
        }
      }

      for (const a of newAnchors) {
        if (!runtimes.has(a.name)) {
          logger.sys(\`[RELOAD] 新增主播: \${a.name}\`);
          const rt: AnchorRuntime = {
            anchor: a,
            state: AnchorState.OFFLINE,
            offlineCount: 0,
            streamFailCount: 0,
            currentRoomId: null,
            recorder: null,
            streamRecorder: null,
          };
          rt.recorder = new Recorder({
            recordsDir: RECORDS_DIR,
            segmentSeconds: SEGMENT_SECONDS,
            onSegmentReady: (anchor, segmentPath, hourDir) => {
              processAsrQueue({ anchor, segmentPath, hourDir });
            },
            onExit: () => {},
          });
          rt.streamRecorder = new StreamRecorder({
            recordsDir: RECORDS_DIR,
            flushSeconds: STREAM_FLUSH_MINUTES * 60,
            onFlush: onStreamFlush,
            onExit: () => {},
          });
          runtimes.set(a.name, rt);
        } else {
          const rt = runtimes.get(a.name)!;
          if (rt.anchor.webRid !== a.webRid || rt.anchor.videoUrl !== a.videoUrl) {
            logger.sys(\`[RELOAD] 更新主播配置: \${a.name}\`);
            rt.recorder?.stop(a.name);
            rt.streamRecorder?.stop(a.name);
            rt.anchor = a;
            rt.state = AnchorState.OFFLINE;
            rt.offlineCount = 0;
            rt.currentRoomId = null;
          }
        }
      }

      logger.sys(\`[RELOAD] 完成，当前监控 \${runtimes.size} 个主播: \${[...runtimes.keys()].join(', ')}\`);
    } catch (e: any) {
      logger.error('system', \`[RELOAD] 失败: \${e.message}\`);
    } finally {
      reloading = false;
    }
  }, 3000);
  // ========== /配置热重载 ==========
`;

c = c.slice(0, startIdx) + newBlock + c.slice(endIdx + oldEnd.length);
fs.writeFileSync(file, c);
console.log('[ok] 热重载已改成信号文件触发');
