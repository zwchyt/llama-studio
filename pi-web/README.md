<!-- @format -->

# pi-web

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的网页界面。在浏览器中浏览会话、与智能体对话、分叉对话、切换消息分支。

## 快速开始

**无需安装，直接运行：**

```bash
npx @agegr/pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @agegr/pi-web
pi-web
```

启动后打开 [http://localhost:30141](http://localhost:30141)。

**可选参数：**

```bash
pi-web --port 8080               # 自定义端口
pi-web --hostname 127.0.0.1      # 仅本机访问
pi-web -p 8080 -H 127.0.0.1     # 组合使用

PORT=8080 pi-web                 # 也支持环境变量
```

## 功能介绍

- **会话浏览器** — 按工作目录分组展示所有 pi 会话
- **实时对话** — 通过 SSE 流式输出与智能体实时交互
- **会话分叉** — 从任意用户消息创建独立的新会话分支
- **会话内分支** — 回退到任意节点继续对话，在同一文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型
- **工具面板** — 控制智能体可使用的工具
- **压缩会话** — 对长会话进行摘要，节省上下文窗口
- **引导 / 追加** — 打断正在运行的智能体，或在其完成后追加消息

## 注意事项

- **数据目录** — 默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他目录。
- **模型配置** — 从智能体数据目录下的 `models.json` 读取可用模型，可在侧边栏的「Models」面板中编辑。
- **文件浏览** — 侧边栏内置文件浏览器，可在标签页中查看当前工作目录下的文件。

## 开发

```bash
npm install
npm run dev   # 端口 30141
```

## pi-web 项目分析

pi-web (@agegr/pi-web v0.6.11) 是 pi coding agent 的 Web UI，让你在浏览器里跟 AI 编程代理交互。

- **技术栈**
  Next.js 16 + React 19 + TypeScript 5 + Tailwind CSS v4，核心依赖 @earendil-works/pi-coding-agent（代理本进程运行）。

## 核心功能

- **聊天式 AI 编程**：SSE 实时流式响应，支持多轮对话
- **会话管理**：自动存为 .jsonl 文件，支持 fork 分支、重命名、删除
- **文件系统**：内置文件浏览器、语法高亮查看器、实时文件监听
- **模型切换**：支持 Anthropic/OpenAI/Google/DeepSeek 等 20+ 供应商
- **技能生态**：可浏览/搜索/安装/开关 agent 技能
- **工具预设**：Off / Low (读/写/编辑/bash) / High (+ grep/find/ls) 三级
- 暗色/亮色主题 + 音频提醒 + 图片拖拽

  ## 架构要点

- 代理作为 Next.js 服务端进程内 运行（lib/rpc-manager.ts）
- 会话存于 ~/.pi/agent/sessions/，10 分钟无活动自动销毁
- 全局变量 globalThis 存储注册表以抵抗热重载
- 文件访问限制在已有会话 cwd 范围内
  一句话：pi coding agent 的官方 Web 客户端，全功能的 AI 编程助手界面。

## 项目结构

```
app/
  api/
    sessions/      # 读写会话文件
    agent/         # 发送命令、SSE 事件流
    files/         # 文件内容读取
    models/        # 可用模型列表与默认模型
    models-config/ # 读写 models.json
components/        # UI 组件
lib/
  session-reader.ts  # 解析 .jsonl 会话文件
  rpc-manager.ts     # 管理 AgentSession 生命周期
  normalize.ts       # 规范化 toolCall 字段名
  types.ts
```

会话文件存储路径：`~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`
