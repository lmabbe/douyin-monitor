---
name: douyin-monitor
description: 抖音主播直播和视频监控。支持查状态、改配置、加主播、排故障。当用户提到"抖音监控"、"主播"、"直播总结"、"微信推送"时使用。
---

# 抖音直播 + 视频监控

## 项目位置

    /data/data/com.termux/files/home/douyin-live/

## 常用命令

    cd /data/data/com.termux/files/home/douyin-live

    # 服务管理
    ./manage.sh start      # 启动
    ./manage.sh stop       # 停止
    ./manage.sh restart    # 重启（改配置后必须执行）
    ./manage.sh status     # 状态
    ./manage.sh log 50     # 最近50行
    ./manage.sh tail       # 实时关键日志

    # 主播管理（Agent 可直接调用）
    ./tools/update-config.sh list                          # 列出所有主播
    ./tools/update-config.sh add <name> <webRid> [videoUrl]  # 加主播
    ./tools/update-config.sh remove <name>                 # 删主播
    ./tools/update-config.sh enable <name>                 # 启用
    ./tools/update-config.sh disable <name>                # 禁用
    ./tools/update-config.sh restore                       # 撤销上次改动

    # 环境变量管理
    ./tools/set-env.sh --list                # 列出所有配置
    ./tools/set-env.sh KEY=VALUE             # 改某个配置
    ./tools/set-env.sh KEY                   # 读取某个配置
    ./tools/set-env.sh --restore             # 撤销上次改动

## 重要：改配置后必须重启

**改 `config/anchors.json` 或 `.env` 后，必须执行 `./manage.sh restart` 才生效。**

**禁止手动编辑这两个文件**——用 `tools/update-config.sh` 和 `tools/set-env.sh`，它们会自动备份。

## 配置项说明

### config/anchors.json

每个主播一条：

    {
      "name": "李一恩",
      "webRid": "97162299125",
      "videoUrl": "https://www.douyin.com/user/MS4wLjABAAAA...",
      "enabled": true
    }

- webRid：直播短号，空则不监控直播
- videoUrl：视频主页，空则不监控视频

### .env 关键变量

    ASR_MODE=stream                # stream（Gemini Live）| segment（SenseVoice）
    STREAM_FLUSH_MINUTES=4         # 落盘间隔（分钟）
    AI_SUMMARY_EVERY=4             # 每 N 片总结一次
    VIDEO_CHECK_MINUTES=5          # 视频检查间隔
    GEMINI_API_KEY=xxx
    GEMINI_LIVE_MODEL=gemini-3.5-transcribe-live
    GEMINI_MODEL=gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-26b-a4b-it
    TENCENT_API_KEY=xxx
    TENCENT_MODEL=qwen3.5-flash
    DOUYIN_COOKIE=xxx

## 目录结构

    records/{主播名}/
    ├── live/{YYYYMMDDHHmm}/         # 开播时间
    │   ├── live_transcript.txt
    │   └── summary.txt
    └── video/{YYYYMMDDHHmm}/        # 视频发布时间（北京时间）
        ├── {视频ID}.m4a
        ├── {视频ID}.txt
        └── {视频ID}.summary.txt

## 日志格式

    [时间] [主播名] [LIVE] ...        # 直播
    [时间] [主播名] [VIDEO] ...       # 视频
    [时间] [wechat] ...              # 微信推送
    [时间] [gemini-live-file] ...    # Gemini 转写

## 微信推送格式

    【LIVE】【主播名】时间\n总结           # 盘中小段
    【LIVE】【主播名】【总结】时间\n总结     # 直播完整总结
    【VIDEO】【主播名】发布时间\n总结       # 视频总结

## 典型工作流

### 用户说"加个主播 XXX"

1. 问用户要 webRid（直播间短号）和 videoUrl（可选）
2. 执行：`./tools/update-config.sh add "XXX" "webRid" "videoUrl"`
3. 执行：`./manage.sh restart`
4. 验证：`./tools/update-config.sh list`
5. 报告结果

### 用户说"看看监控状态"

1. `./manage.sh status`
2. `grep -E "\[LIVE\]|\[VIDEO\]" monitor.out | tail -30`
3. 汇总报告

### 用户说"微信收不到推送"

1. `grep wechat monitor.out | tail -20`
2. 检查 `.wechat-cred.json` 里的 `contextToken`
3. 提醒：**iLink 连续推送 10 条后，需要用户主动给 ClawBot 发消息保活**
4. 如果 token 过期，让用户重新扫码

### 用户说"直播结束没总结"

1. `grep "LIVE ended" monitor.out | tail -10`
2. **没有 LIVE ended**：检查 `src/index.ts` 里 `tick()` 的触发条件
3. **有 LIVE ended 但没总结**：检查 `findLatestTranscript` 能否找到文件
4. `find records/{主播名}/live/ -name "*.txt"`

### 用户说"看某主播的直播文字"

1. `ls records/{主播名}/live/`
2. `cat records/{主播名}/live/{时间戳}/live_transcript.txt`

### 用户说"重置视频监控"

1. `rm -f .video-state.json`
2. `rm -rf records/*/video/`
3. `./manage.sh restart`

## 故障排查

### 微信推送失败
- iLink 10 条限制，让用户主动发消息保活
- 检查 `.wechat-cred.json` 的 `contextToken`
- `grep wechat monitor.out | tail -20`

### Gemini Live 返回 0 字
- 检查 `src/asr/gemini-live-file.ts` 的 `setTimeout(finish, 60000)`

### polydl 报错
- Cookie 失效：让用户重新获取 `DOUYIN_COOKIE`
- `cat node_modules/polydl/dist/index.d.ts` 看 API

### Gemini 429
- 自动降级到腾讯 qwen
- 禁用记录在 `.gemini-disabled.json`，每天 0 点重置

## 费用

Gemini Live: $0.009/分钟，每天约 $5

## 备份

    tar -czf backup.tar.gz .env config .wechat-cred.json .video-state.json
