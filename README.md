# 抖音直播 + 视频监控系统

监控抖音主播的直播和视频，自动转文字、AI 总结、推送微信。

## 系统架构

    抖音主播（直播流 + 视频主页）
        |
    +---+---+
    |       |
 直播监控  视频监控
 30秒检查  5分钟检查
    |       |
 FFmpeg拉流  polydl下载
 PCM输出    FFmpeg提音频
    |       |
 Gemini Live  Gemini Live
 流式转写      文件转写
    |       |
 4分钟落盘    写xxx.txt
    |       |
 AI总结      AI总结
    +---+---+
        |
   微信推送

## 目录结构

    douyin-live/
    ├── .env                         # 环境变量
    ├── .video-state.json            # 视频监控基准时间
    ├── .wechat-cred.json            # 微信登录凭证
    ├── config/
    │   └── anchors.json             # 主播配置
    ├── records/
    │   ├── 李一恩/
    │   │   ├── live/                # 直播录制
    │   │   │   └── 202609151303/    # YYYYMMDDHHmm
    │   │   │       ├── live_transcript.txt
    │   │   │       └── summary.txt
    │   │   └── video/               # 视频录制
    │   │       └── 202609151316/    # YYYYMMDDHHmm
    │   │           ├── xxx.m4a
    │   │           ├── xxx.txt
    │   │           └── xxx.summary.txt
    │   └── 麦麦吉/...
    ├── src/
    │   ├── index.ts                 # 主入口
    │   ├── douyin/                  # 抖音 API
    │   ├── recorder/                # 录音
    │   ├── asr/                     # 语音识别
    │   ├── ai/                      # AI 总结
    │   └── video/                   # 视频监控
    ├── manage.sh                    # 管理脚本
    ├── monitor.out                  # 运行日志
    └── outbox.jsonl                 # 微信推送队列

## 配置

### .env

    DOUYIN_COOKIE=sessionid=xxx; ttwid=xxx
    ASR_MODE=stream
    STREAM_FLUSH_MINUTES=4
    AI_SUMMARY_EVERY=4
    VIDEO_CHECK_MINUTES=5
    GEMINI_API_KEY=xxx
    GEMINI_MODEL=gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-26b-a4b-it
    GEMINI_LIVE_MODEL=gemini-3.5-transcribe-live
    TENCENT_API_KEY=xxx
    TENCENT_BASE_URL=https://tokenhub.tencentmaas.com/v1
    TENCENT_MODEL=qwen3.5-flash
    SENSEVOICE_DIR=/data/data/com.termux/files/home/sensevoice
    SENSEVOICE_BIN=/data/data/com.termux/files/home/sensevoice/llama-funasr-sensevoice
    SENSEVOICE_MODEL=/data/data/com.termux/files/home/sensevoice/gguf/sensevoice-small-q8.gguf
    SENSEVOICE_VAD=/data/data/com.termux/files/home/sensevoice/gguf/fsmn-vad.gguf
    ASR_SERVER_URL=http://192.168.0.105:3000
    NODE_OPTIONS=--dns-result-order=ipv4first

### config/anchors.json

    [
      {
        "name": "李一恩",
        "webRid": "97162299125",
        "videoUrl": "https://www.douyin.com/user/MS4wLjABAAAA...",
        "enabled": true
      },
      {
        "name": "test",
        "webRid": "824232257612",
        "videoUrl": "",
        "enabled": true
      }
    ]

字段说明：
- name：主播名
- webRid：直播间短号。为空则不监控直播
- videoUrl：视频主页。为空则不监控视频
- enabled：是否启用

## 管理命令

    cd /data/data/com.termux/files/home/douyin-live

    ./manage.sh start       # 启动
    ./manage.sh stop        # 停止
    ./manage.sh restart     # 重启
    ./manage.sh status      # 状态
    ./manage.sh log         # 最近30行
    ./manage.sh log 100     # 最近100行
    ./manage.sh log -f      # 实时
    ./manage.sh tail        # 实时过滤
    ./manage.sh clean       # 清空日志

## 关键机制

### 直播监控
- 检查频率：每 30 秒
- 开播检测：连续 3 次 OFFLINE 判定下播
- 流式模式：FFmpeg PCM → Gemini Live → 每 4 分钟落盘
- 下播：LIVE ended → 停止 → 用整场文字稿生成完整总结 → 推送微信

### 视频监控
- 检查频率：每 5 分钟
- 基准时间：.video-state.json 记录"最后处理时间"
- 首次：只处理最新 1 条
- 增量：找发布时间 > 基准时间的
- 时区：polydl 返回 UTC，代码里 -8 小时转北京时间

### 微信推送格式
- 直播盘中小段：【LIVE】【主播名】时间
- 直播完整总结：【LIVE】【主播名】【总结】时间
- 视频总结：【VIDEO】【主播名】发布时间

iLink 限制：Bot 连续推送 10 条后，需要用户主动回复。

### AI 降级链
Gemini（多模型轮询） → 腾讯 qwen → 原始文本

## 常用操作

新增主播：改 anchors.json + ./manage.sh restart

改时长：sed -i 's|STREAM_FLUSH_MINUTES=.*|STREAM_FLUSH_MINUTES=6|' .env

看文字稿：cat records/李一恩/live/202609151303/live_transcript.txt

看视频总结：cat records/李一恩/video/202609151316/*.summary.txt

重置视频：rm -f .video-state.json && rm -rf records/*/video/ && ./manage.sh restart

## 费用

- Gemini Live：$0.009/分钟
- 估算：每天约 $5，每月约 $150

## 常见问题

Q: 微信收不到？
1. iLink 10 条限制，给 ClawBot 发消息保活
2. 检查 .wechat-cred.json 里的 contextToken
3. grep wechat monitor.out | tail -20

Q: 直播结束没发总结？
看日志有没有 LIVE ended。没有的话检查 rt.state 和 offlineCount。

Q: Gemini Live 返回 0 字？
检查 gemini-live-file.ts 的 setTimeout(finish, 60000)。

## 后台运行

    termux-wake-lock
    tmux new -s douyin
    cd /data/data/com.termux/files/home/douyin-live
    ./manage.sh start
    # Ctrl+B, D 脱离

## 备份

    cd /data/data/com.termux/files/home
    tar -czf douyin-live-backup-$(date +%Y%m%d).tar.gz \
      douyin-live/.env \
      douyin-live/config \
      douyin-live/.wechat-cred.json \
      douyin-live/.video-state.json

## 更新日志

- 2026-09-15：视频监控接入 Gemini Live，直播总结加【总结】标记
- 2026-09-14：系统初版


---

## 启动步骤

### 首次部署

#### 1. 装依赖

Termux:
    pkg update
    pkg install ffmpeg nodejs-lts git make clang

Ubuntu/Debian:
    sudo apt update
    sudo apt install ffmpeg git
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install nodejs

macOS:
    brew install ffmpeg node@22 git

验证:
    which ffmpeg && ffmpeg -version | head -1
    which node && node -v

#### 2. 进项目目录

    cd /data/data/com.termux/files/home/douyin-monitor

#### 3. 装依赖

    npm install

#### 4. 配置 .env

必须：
    GEMINI_API_KEY=xxx
    TENCENT_API_KEY=xxx
    DOUYIN_COOKIE=xxx

可选：
    ASR_MODE=stream
    STREAM_FLUSH_MINUTES=4
    AI_SUMMARY_EVERY=4
    VIDEO_CHECK_MINUTES=5

#### 5. 配置主播

编辑 config/anchors.json:
    [
      {
        "name": "李一恩",
        "webRid": "97162299125",
        "videoUrl": "https://www.douyin.com/user/MS4wLjABAAAA...",
        "enabled": true
      }
    ]

#### 6. 启动

    ./manage.sh start

#### 7. 验证

    ./manage.sh status
    ./manage.sh log 30

看到这些说明成功:
    [system] === 抖音直播 + 视频监控启动 ===
    [system] ASR 模式: stream
    [system] [wechat] 使用已保存凭证，直接监听
    [system] 已加载 N 个主播
    [李一恩] [LIVE] OFFLINE (1/3)

### 日常启动

启动:
    ./manage.sh start

状态:
    ./manage.sh status
    ./manage.sh log 30
    ./manage.sh log -f
    ./manage.sh tail

停止:
    ./manage.sh stop

重启:
    ./manage.sh restart

### 首次微信登录

首次启动时，如果 .wechat-cred.json 不存在：
1. 终端显示二维码
2. 用微信扫一扫
3. 授权后凭证保存
4. 重启不需要再扫码

重要：首次登录后，去微信里给 ClawBot 发一条消息（比如"hi"），
激活 contextToken。之后才能收到推送。

### 后台长期运行

Termux:
    termux-wake-lock
    pkg install tmux
    tmux new -s douyin
    cd /data/data/com.termux/files/home/douyin-monitor
    ./manage.sh start
    # Ctrl+B 然后 D 脱离

恢复:
    tmux attach -t douyin

### 验证状态

进程:
    ./manage.sh status

日志:
    ./manage.sh log 30

目录:
    find records -type d | head -20

微信:
    grep wechat monitor.out | tail -10

### 常见问题

spawn ffmpeg ENOENT:
    pkg install ffmpeg

Cannot find module:
    npm install

启动后立刻退出:
    ./manage.sh log 50
    tail -100 monitor.out

微信没显示二维码:
    rm -f .wechat-cred.json
    ./manage.sh restart

### 更新代码

    ./manage.sh stop
    git pull
    npm install
    ./manage.sh start

