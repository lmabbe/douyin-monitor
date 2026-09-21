# 抖音直播 + 视频监控系统

## 一句话介绍

一个长期运行的抖音主播监控系统，同时监控**直播**和**视频更新**，自动完成：

> 发现直播/视频 → 音频获取 → ASR 转文字 → AI 提炼观点 → 微信推送

核心目标是减少人工盯直播和刷视频的时间，同时保留完整文字稿和总结记录。

---

## 1. 系统整体架构

```text
                 抖音主播
                /        \
             直播          视频
              |             |
        30 秒检查       5~10 分钟随机检查
              |             |
          FFmpeg 拉流     polydl 下载
              |             |
           PCM 音频      FFmpeg 提音频
              |             |
             ASR           ASR
              |             |
             AI 小结       AI 总结
              \             /
                微信推送
```

### 主要处理链

**直播：**

```text
直播状态检测
    ↓
FFmpeg 拉流
    ↓
Gemini Live / Groq Whisper / SenseVoice
    ↓
文字稿
    ↓
定期 AI 小结
    ↓
下播后整场总结
    ↓
微信推送
```

**视频：**

```text
视频列表检查
    ↓
发现新视频
    ↓
polydl 下载
    ↓
提取音频
    ↓
ASR
    ↓
AI 总结
    ↓
微信推送
```

---

## 2. 核心功能

- **长期运行**：后台常驻、自动重连、错误冷却、进程管理
- **直播监控**：约 30 秒检查一次，开播自动录制，下播自动总结
- **视频监控**：5~10 分钟随机检查，只处理新增视频
- **ASR 降级**：Groq Whisper → 本地 SenseVoice
- **AI 降级**：
  - 小结 / 单视频：Gemini → Groq → 腾讯 → 原始文本
  - 整场直播：Gemini → 腾讯 → 原始文本
- **微信推送**：开播提醒、直播小结、下播总结、视频总结
- **多主播**：一个进程可以监控多个主播
- **热重载**：修改主播配置和 Prompt 后可以 reload
- **本地优先**：ASR 可以使用本地 SenseVoice 作为兜底

---

## 3. 一个非常重要的限制：微信 10 条消息

系统使用 iLink Bot 推送微信。

当前存在一个平台限制：

> Bot 连续推送约 10 条消息后，需要用户主动回复一条消息，才能继续接收推送。

因此：

```text
Bot 推送 1~10 条
        ↓
用户没有回复
        ↓
后续消息进入 outbox.jsonl
        ↓
用户回复一条消息
        ↓
积压消息继续发送
```

### 实际使用建议

直播期间如果推送比较频繁：

- 每收到 5~8 条推送，回复一次
- 无人值守时定期回复
- 如果发现推送停止，可以先回复 `1` 测试

推送队列使用 `outbox.jsonl`，因此消息不会因为暂时无法发送而直接丢失。

---

## 4. ASR 架构

### 主链

```text
Groq Whisper
    ↓ 失败
本地 SenseVoice
```

Groq Whisper 主要负责快速转写。

本地 SenseVoice 作为离线兜底。

### 支持模式

系统目前有：

- `stream`：流式处理
- `segment`：切片处理

流式模式主要用于直播：

```text
FFmpeg PCM
    ↓
Gemini Live
    ↓
持续获得转写文本
    ↓
每 N 分钟落盘 + AI 小结
```

---

## 5. AI 总结架构

### 小结 / 视频总结

```text
Gemini
  ↓ 失败
Groq
  ↓ 失败
腾讯
  ↓ 失败
原始文本
```

### 整场直播总结

```text
Gemini
  ↓ 失败
腾讯
  ↓
原始文本
```

整场直播文本可能非常长，因此没有把 Groq 作为主要整场总结方案。

---

## 6. 直播监控机制

### 状态检查

- 每约 30 秒检查一次
- 连续 OFFLINE 状态用于判断是否真正下播
- 连续失败达到阈值后进入 ERROR
- 冷却后自动重试

### 开播

```text
检测 LIVE
 ↓
开始录制
 ↓
启动 ASR
 ↓
持续产生文字稿
 ↓
定期 AI 小结
 ↓
微信推送
```

### 下播

```text
检测下播
 ↓
停止录音
 ↓
等待 ASR 队列处理完成
 ↓
生成整场总结
 ↓
微信推送
 ↓
保存完整记录
```

---

## 7. 视频监控机制

视频检查间隔为 **5~10 分钟随机检查**。

使用 `.video-state.json` 保存基准时间。

### 首次运行

首次运行不会把历史视频全部处理，而是只处理最新的一条。

### 后续运行

只处理：

```text
发布时间 > 上一次处理时间
```

因此属于增量监控。

系统还处理了 `polydl` 返回时间与北京时间之间的时区转换。

---

## 8. 微信推送类型

系统目前主要有四种推送：

| 类型 | 格式 |
|---|---|
| 开播提醒 | `【LIVE】【主播名】时间` |
| 直播盘中小结 | `【LIVE】【主播名】时间` |
| 直播完整总结 | `【LIVE】【主播名】【总结】时间` |
| 视频总结 | `【VIDEO】【主播名】发布时间` |

---

## 9. 配置结构

### 主播

`config/anchors.json`

主要字段：

```json
{
  "name": "主播名",
  "webRid": "直播间短号",
  "videoUrl": "视频主页",
  "enabled": true
}
```

其中：

- `name`：主播名称
- `webRid`：直播间标识，为空时不监控直播
- `videoUrl`：视频主页，为空时不监控视频
- `enabled`：是否启用

### AI Prompt

`config/prompts.json`

主要包括：

- `cleanTranscript.system`：ASR 文字纠错
- `summarizeSegment.system`：切片 / 视频小结
- `summarizeSession.system`：整场直播总结

修改后可以：

```bash
./manage.sh reload
```

无需完整重启。

---

## 10. 关键环境变量

```bash
# AI
GEMINI_API_KEY=xxx
GROQ_API_KEY=xxx
TENCENT_API_KEY=xxx

# 抖音
DOUYIN_COOKIE=sessionid=xxx; ttwid=xxx

# ASR
ASR_MODE=stream
STREAM_FLUSH_MINUTES=4
AI_SUMMARY_EVERY=4

# 视频
VIDEO_CHECK_MINUTES=5,10

# AI 模型
GEMINI_MODEL=gemini-2.0-flash,gemini-1.5-flash
GROQ_MODEL=openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile
GROQ_WHISPER_MODEL=whisper-large-v3-turbo,whisper-large-v3
TENCENT_MODEL=qwen3.5-flash
```

---

## 11. 依赖

### 基础环境

- Node.js 20+
- pnpm 9+
- FFmpeg 6+
- Git
- tmux（可选）

### 支持平台

- macOS
- Linux
- Android / Termux

Termux 还需要额外的 `glibc-runner`，用于运行部分 glibc 二进制。

---

## 12. 运行方式

安装依赖：

```bash
pnpm install
```

启动：

```bash
./manage.sh start
```

查看状态：

```bash
./manage.sh status
```

查看日志：

```bash
./manage.sh log 30
```

实时日志：

```bash
./manage.sh log follow
```

热重载：

```bash
./manage.sh reload
```

停止：

```bash
./manage.sh stop
```

重启：

```bash
./manage.sh restart
```

---

## 13. 后台长期运行

推荐使用 `tmux`。

```bash
tmux new -s douyin
cd ~/douyin-monitor
./manage.sh start
```

退出 tmux：

```text
Ctrl+B → D
```

重新进入：

```bash
tmux attach -t douyin
```

Linux 还可以进一步使用 systemd 设置开机自启。

---

## 14. 数据目录

```text
records/
├── 主播A/
│   ├── live/
│   │   └── 某场直播/
│   │       ├── live_transcript.txt
│   │       └── summary.txt
│   └── video/
│       └── 某个视频/
│           ├── xxx.m4a
│           ├── xxx.txt
│           └── xxx.summary.txt
└── 主播B/
```

因此系统不仅负责推送，还会在本地保存：

- 直播录音
- 直播文字稿
- 直播总结
- 视频音频
- 视频文字稿
- 视频总结

---

## 15. 项目结构

```text
douyin-monitor/
├── config/
│   ├── anchors.json
│   ├── prompts.json
│   └── websign_env.json
├── records/
├── src/
│   ├── douyin/
│   ├── recorder/
│   ├── asr/
│   ├── ai/
│   ├── live/
│   ├── video/
│   └── wechat/
├── manage.sh
├── monitor.out
└── outbox.jsonl
```

核心模块：

| 模块 | 作用 |
|---|---|
| `douyin/` | 抖音 API / 数据获取 |
| `recorder/` | 直播录制 |
| `asr/` | 语音识别 |
| `ai/` | AI 总结及降级 |
| `live/` | 直播状态与生命周期 |
| `video/` | 视频增量监控 |
| `wechat/` | 微信推送 |

---

## 16. 常见问题

### 启动后退出

首先：

```bash
./manage.sh log 50
tail -100 monitor.out
```

常见原因：

- `spawn ffmpeg ENOENT` → FFmpeg 未安装
- `Cannot find module` → 未执行 `pnpm install`
- `GEMINI_API_KEY 未配置` → 环境变量缺失

### 微信收不到消息

优先检查：

```bash
wc -l outbox.jsonl
grep wechat monitor.out | tail -20
```

如果 `outbox.jsonl` 持续增长，可能是消息发送受阻。

然后检查：

```bash
cat .wechat-cred.json | grep contextToken
```

如果没有有效 `contextToken`，需要先在微信给 Bot 发一条消息。

### 直播结束没有总结

检查：

```bash
grep "LIVE ended" monitor.out | tail -5
```

重点检查直播运行状态以及 offline 计数。

### 抖音 Cookie 失效

如果出现：

```text
status_code=8
```

需要重新获取 Cookie，并更新配置。

### ASR 失败

可以分别测试 Groq Whisper 和本地 SenseVoice。

---

## 17. 常用维护操作

### 新增主播

修改：

```text
config/anchors.json
```

然后：

```bash
./manage.sh reload
```

### 修改小结频率

修改：

```bash
STREAM_FLUSH_MINUTES=6
```

然后重启。

### 修改 AI 模型

修改 `.env` 中对应模型配置，然后重启。

### 修改 Prompt

修改：

```text
config/prompts.json
```

然后：

```bash
./manage.sh reload
```

### 重置视频监控

```bash
rm -f .video-state.json
rm -rf records/*/video/
./manage.sh restart
```

### 更新代码

```bash
./manage.sh stop
git pull
pnpm install
./manage.sh start
```

---

## 18. 成本

原文档给出的估算是：

| 项目 | 费用 |
|---|---:|
| Gemini | 免费额度 |
| Groq Whisper | 免费额度 |
| Groq Chat | 免费额度 |
| 腾讯 TokenHub | 免费额度 |
| 微信推送 | 免费 |
| **合计** | **约 ¥0 / 月** |

实际使用量较高时，需要注意各平台免费额度和限流。

---

## 19. 项目核心特点总结

这个项目本质上是一个：

> **“抖音内容自动采集 → 语音识别 → AI 信息提炼 → 微信通知 → 本地归档”的长期运行管道。**

它解决的不是单纯的“下载直播”或“转文字”，而是把整个流程自动化：

```text
┌──────────────┐
│ 抖音直播/视频 │
└──────┬───────┘
       ↓
┌──────────────┐
│ 自动发现内容 │
└──────┬───────┘
       ↓
┌──────────────┐
│ 音频获取/录制 │
└──────┬───────┘
       ↓
┌──────────────┐
│     ASR      │
│  语音 → 文字 │
└──────┬───────┘
       ↓
┌──────────────┐
│      AI      │
│ 纠错 + 总结  │
└──────┬───────┘
       ↓
┌──────────────┐
│   微信推送   │
└──────┬───────┘
       ↓
┌──────────────┐
│   本地归档   │
└──────────────┘
```

**最终产物主要有三类：**

1. **实时信息**：微信收到直播小结
2. **完整信息**：下播后的整场总结 / 视频总结
3. **原始资料**：本地保存的录音和完整文字稿
