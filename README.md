<div align="center">
  <img src="assets/github-logo-hexllama.png" alt="llama-studio Logo" width="400" />
</div>

<p align="center">
  <img src="https://img.shields.io/github/v/release/zwchyt/llama-studio?style=flat-square&color=black&label=version" alt="Latest Version" />
  <img src="https://img.shields.io/badge/Electron-191970?style=flat-square&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=flat-square&logo=vite&logoColor=FFD62E" alt="Vite" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

<p align="center">
  <b>llama-studio</b> — 基于 <a href="https://github.com/ggml-org/llama.cpp">llama.cpp</a> 的本地大模型桌面管理工具。
  <br/>
  在 Hugging Face 搜索模型、一键下载、模板化配置、多实例并发运行。
</p>

---

## ✨ 核心功能

### 🔍 集成模型 Hub
直接在应用中搜索 Hugging Face 和 modelscope。浏览仓库、查看文件详情、一键下载 GGUF 模型——无需打开浏览器。

### ⬇️ 智能下载管理器
支持暂停、恢复、取消大模型下载。根据量化等级自动生成执行模板和推荐参数。

### 📋 模板化执行
将模型配置保存为可复用的模板。在多端口上同时运行多个模型。支持 **Chat UI** 和 **API Only** 两种启动模式。

### 🔄 版本与后端管理
维护和切换多个 llama.cpp 二进制版本。自动检查新版本，在设置面板中一键下载更新。

### 🖼️ OCR 文字识别
内置 OCR 视图，利用 llama.cpp 从图片中提取文字，全程本地处理。

### 🤖 AI Agent 集成
在侧边栏中管理和启动基于 npm 的 AI 代理脚本，扩展自动化工作流。

---

## 🛠️ 技术栈

| 层级 | 技术 |
|-------|-----------|
| 桌面框架 | [Electron](https://www.electronjs.org/) 43 |
| UI 框架 | [React](https://react.dev/) 19 |
| 语言 | [TypeScript](https://www.typescriptlang.org/) 5 |
| 构建工具 | [Vite](https://vitejs.dev/) 5 + [electron-vite](https://electron-vite.org/) |
| 状态管理 | [Zustand](https://github.com/pmndrs/zustand) |
| 终端 | [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) |
| Markdown 渲染 | [react-markdown](https://github.com/remarkjs/react-markdown) + [KaTeX](https://katex.org/) |
| 文档解析 | [PDF.js](https://mozilla.github.io/pdf.js/)、[Mammoth.js](https://github.com/mwilliamson/mammoth.js) |
| PDF 导出 | [jsPDF](https://github.com/parallax/jsPDF) + [html2canvas](https://html2canvas.hertzen.com/) |
| 图标 | [Lucide React](https://lucide.dev/) |
| 打包 | [electron-builder](https://www.electron.build/) |

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 18
- **npm**
- **Git**

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/zwchyt/llama-studio.git
cd llama-studio

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

### 打包构建

```bash
npm run build
```

编译后的安装包位于 `dist/` 目录。

> **注意**：如果嵌入式终端遇到问题，请为 Electron 重建 `node-pty`：
> ```bash
> npx electron-rebuild -w node-pty
> ```

---

## 📖 使用指南

### 1. 浏览与下载模型
- 打开 **模型 Hub** 标签页，搜索 Hugging Face 上的 GGUF 模型。
- 点击模型查看详情，选择量化版本，一键下载。

### 2. 创建执行模板
- 进入 **我的模板**，点击 **新建模板**。
- 选择已下载的模型，配置上下文长度、GPU 层数等 llama.cpp 参数。
- 选择 **Chat UI**（交互对话）或 **API Only**（服务端）启动模式。

### 3. 运行模型
- 在模板上点击 **运行**，后端会在终端视图中自动启动。
- Chat UI 模式可直接对话；API Only 模式使用提供的端点地址。

### 4. 管理后端
- 进入 **设置** → **后端**，切换或更新 llama.cpp 版本。

### 5. 使用 AI Agent
- 从侧边栏打开 **Agents** 面板，管理基于 npm 的代理脚本。

### 6. OCR 与文档处理
- 在 OCR 视图中上传图片，利用正在运行的模型提取文字。

---

## ⚙️ 配置说明

### Electron Builder (`electron-builder.yml`)
配置应用打包参数——应用 ID、安装程序类型、文件关联、签名等。

### 聊天模板 (`chat-templates/`)
将自定义 Jinja2 聊天模板放入此目录，应用会自动加载。

### 执行模板 (`templates/`)
保存模板时自动生成，每个文件是一个以 UUID 命名的 JSON：
```json
{
  "id": "uuid",
  "name": "我的模板",
  "modelPath": "models/qwen2.5-7b-q4_k_m.gguf",
  "ctxSize": 8192,
  "gpuLayers": 33,
  "port": 8080,
  "mode": "chat"
}
```

### 设置文件 (`settings.json`)
自动生成的全局偏好配置（主题、后端路径、下载目录等）。

---

## 🙏 致谢

- **[hexllama](https://github.com/andersondanieln/hexllama)** — 上游 fork 来源及核心框架
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** — 由 Georgi Gerganov 及 ggml-org 社区维护

---

## 🔒 隐私声明

本应用 **完全本地运行**。不收集、不存储、不传输任何遥测或个人数据。模型下载依赖第三方服务（Hugging Face和ModelScope），后端二进制文件遵循各自的许可协议。

---

## 📄 许可证

本项目基于 [hexllama](https://github.com/andersondanieln/hexllama) 衍生。详见 [LICENSE](LICENSE) 文件。

---

<div align="center">
  <sub>为本地 AI 社区而建 ❤️</sub>
</div>

