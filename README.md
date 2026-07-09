<div align="center">
  <img src="assets/github-logo-hexllama.png" alt="llama-studio Logo" width="400" />
</div>

<p align="center">
  <img src="https://img.shields.io/github/v/release/zwchyt/llama-studio?style=flat-square&color=black&label=version" alt="Latest Version" />
  <img src="https://img.shields.io/badge/Electron-191970?style=flat-square&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=flat-square&logo=vite&logoColor=FFD62E" alt="Vite" />
</p>

<br/>

**llama-studio** is a desktop GUI for managing and running local Large Language Models via llama.cpp. Forked from [hexllama](https://github.com/andersondanieln/hexllama), with bug fixes, UI enhancements, OCR recognition, AI Agent integration, and other improvements.

## Features

**Integrated Model Hub**
Search Hugging Face directly within the application. Browse repositories, view file details, and download GGUF models with a single click.

![Model Hub](assets/screenshots/model-hub.png)

**Smart Download Manager**
Pause, resume, or cancel large model downloads. Automatically generates execution templates with recommended parameters based on the model's quantization level.

![Model Download](assets/screenshots/model-download.png)

**Template-Based Execution**
Save configurations as reusable templates. Run multiple models simultaneously on different ports. Launch in "Chat UI" mode or "API Only" mode.

![My Templates](assets/screenshots/my-templates.png)

![Template Settings](assets/screenshots/template-edit-model-settings-parameters.png)

**Version and Backend Management**
Maintain and switch between multiple llama.cpp binaries. Auto-checks for new releases and handles downloads from the settings panel.

![Settings](assets/screenshots/settings.png)

**OCR Recognition**
Built-in OCR view for document text extraction using llama.cpp.

**AI Agent Integration**
Manage and launch npm-based AI agents directly from the sidebar.

## Installation

### Download the Release

1. Go to the [Releases](https://github.com/zwchyt/llama-studio/releases) page.
2. Download the installer for your operating system.
3. Run the installer.

### Build from Source

Prerequisites:
- Node.js 18 or higher
- npm
- Git

```bash
# Clone the repository
git clone https://github.com/zwchyt/llama-studio.git

# Enter the project directory
cd llama-studio

# Install dependencies
npm install

# Start the development server
npm run dev
```

To compile the application into an executable:

```bash
npm run build
```

## Acknowledgements

This project is built upon the following open-source projects:

- **[hexllama](https://github.com/andersondanieln/hexllama.git)** — original author: andersondanieln, provides the core framework
- **[pi-web](https://github.com/agegr/pi-web.git)** — original author: agegr, provides web interface and component support
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** — by Georgi Gerganov and the ggml-org community

This repository has integrated features, fixed bugs, and independently developed upon these projects.

## Privacy and Terms

This application is strictly local. It does not collect, store, or transmit any telemetry or personal data. Downloading models relies on third-party services like Hugging Face, and executing backends relies on the downloaded binaries, both of which are subject to their own respective privacy policies.

The software is provided as-is, without warranty of any kind.
