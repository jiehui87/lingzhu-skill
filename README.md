# OpenClaw Lingzhu Skill

[English](#english) | [中文](#中文)

---

## English

### Overview

**OpenClaw Lingzhu Skill** is a protocol conversion bridge plugin that integrates the **Lingzhu platform** (灵珠平台) with **OpenClaw**, enabling seamless interaction between Rokid Glasses and AI agents. The plugin converts requests from the Lingzhu platform to OpenClaw's OpenAI-compatible API format and routes device commands through the AI agent.

### Key Features

- 🔌 **Protocol Conversion**: Seamlessly converts between Lingzhu and OpenAI API formats
- 📡 **SSE Streaming**: Server-Sent Events (SSE) support for real-time responses
- 🎯 **Device Integration**: Control Rokid Glasses features through AI agent
  - 📷 Camera control (take photos)
  - 🗺️ Navigation
  - 📅 Calendar and reminders
  - 🚪 Agent session management
- 🔐 **Secure Authentication**: Bearer token-based authentication with auto-generated keys
- 🌐 **Multimodal Support**: Handle text and image inputs
- 💾 **Image Caching**: Automatic image downloading and local caching
- 🛠️ **CLI Tools**: Built-in commands for status monitoring and configuration

### Architecture

```
Rokid Glasses → Lingzhu Platform → Plugin → OpenClaw → AI Agent
                                      ↓
                               Device Commands
                        (camera, navigation, calendar)
```

### Installation

```bash
# Install from local directory
openclaw plugins install ./skill/extension

# Or use development mode (link)
openclaw plugins install -l ./skill/extension
```

### Quick Start

1. **Enable HTTP Chat Completions endpoint** in `openclaw.json`:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

2. **Configure the plugin** in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "lingzhu": {
        "enabled": true,
        "config": {
          "authAk": "",      // Leave empty for auto-generation
          "agentId": "main"  // Optional, defaults to "main"
        }
      }
    }
  }
}
```

3. **Start the gateway** and note the connection information:

```bash
openclaw lingzhu info
```

4. **Configure Lingzhu platform** with the displayed SSE endpoint and authentication key.

### CLI Commands

```bash
# Display connection information
openclaw lingzhu info

# Check plugin status
openclaw lingzhu status
```

### API Endpoint

**POST /metis/agent/api/sse**

- **Authentication**: `Authorization: Bearer <AK>`
- **Request Format**: JSON with message_id, agent_id, and messages
- **Response Format**: Server-Sent Events (SSE) streaming

See [skill/extension/README.md](skill/extension/README.md) for detailed API documentation and examples.

### Project Structure

```
openclaw-lingzhu-skill/
├── skill/
│   ├── SKILL.md                    # Skill metadata and command mapping
│   ├── references/
│   │   └── install.md             # Detailed installation guide
│   └── extension/                  # Main plugin code
│       ├── README.md              # Comprehensive user documentation
│       ├── package.json           # Plugin dependencies
│       ├── index.ts               # Plugin entry point
│       ├── openclaw.plugin.json   # OpenClaw plugin configuration
│       └── src/
│           ├── types.ts           # TypeScript type definitions
│           ├── config.ts          # Configuration management
│           ├── http-handler.ts    # HTTP request handling
│           ├── transform.ts       # Message format transformation
│           ├── lingzhu-tools.ts   # Device tool definitions
│           └── cli.ts             # CLI command registration
```

### Documentation

- **[Installation Guide](skill/references/install.md)**: Step-by-step integration with Lingzhu platform
- **[Plugin README](skill/extension/README.md)**: Detailed configuration, usage, and API reference
- **[Skill Metadata](skill/SKILL.md)**: Device command mapping and requirements

### Device Commands

| OpenClaw Tool | Lingzhu Command | Description |
|--------------|-----------------|-------------|
| take_photo, camera, photo | take_photo | Camera control |
| navigate, navigation, maps | take_navigation | GPS navigation |
| calendar, schedule, reminder | control_calendar | Calendar/reminders |
| exit, quit | notify_agent_off | Exit agent session |

### Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js (ES Modules)
- **CLI Framework**: Commander.js
- **API Format**: OpenAI-compatible chat completions

### License

MIT

---

## 中文

### 项目简介

**OpenClaw Lingzhu Skill** 是一个协议转换桥接插件，用于将**灵珠平台**与 **OpenClaw** 集成，实现 Rokid Glasses 与 AI 智能体之间的无缝交互。该插件将来自灵珠平台的请求转换为 OpenClaw 的 OpenAI 兼容 API 格式，并通过 AI 智能体路由设备命令。

### 核心功能

- 🔌 **协议转换**：在灵珠平台和 OpenAI API 格式之间无缝转换
- 📡 **SSE 流式传输**：支持 Server-Sent Events (SSE) 实时响应
- 🎯 **设备集成**：通过 AI 智能体控制 Rokid Glasses 功能
  - 📷 相机控制（拍照）
  - 🗺️ 导航
  - 📅 日程和提醒
  - 🚪 智能体会话管理
- 🔐 **安全认证**：基于 Bearer token 的身份验证，支持自动生成密钥
- 🌐 **多模态支持**：处理文本和图像输入
- 💾 **图像缓存**：自动下载和本地缓存图像
- 🛠️ **CLI 工具**：内置状态监控和配置命令

### 系统架构

```
Rokid Glasses → 灵珠平台 → 插件 → OpenClaw → AI 智能体
                              ↓
                        设备命令
                 (相机、导航、日程)
```

### 安装

```bash
# 从本地目录安装
openclaw plugins install ./skill/extension

# 或使用开发模式（链接）
openclaw plugins install -l ./skill/extension
```

### 快速开始

1. **在 `openclaw.json` 中启用 HTTP Chat Completions 端点**：

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

2. **在 `openclaw.json` 中配置插件**：

```json
{
  "plugins": {
    "entries": {
      "lingzhu": {
        "enabled": true,
        "config": {
          "authAk": "",      // 留空自动生成
          "agentId": "main"  // 可选，默认为 "main"
        }
      }
    }
  }
}
```

3. **启动网关**并记录连接信息：

```bash
openclaw lingzhu info
```

4. **在灵珠平台中配置**显示的 SSE 端点和认证密钥。

### CLI 命令

```bash
# 显示连接信息
openclaw lingzhu info

# 检查插件状态
openclaw lingzhu status
```

### API 端点

**POST /metis/agent/api/sse**

- **认证方式**：`Authorization: Bearer <AK>`
- **请求格式**：包含 message_id、agent_id 和 messages 的 JSON
- **响应格式**：Server-Sent Events (SSE) 流式传输

详细的 API 文档和示例请参阅 [skill/extension/README.md](skill/extension/README.md)。

### 项目结构

```
openclaw-lingzhu-skill/
├── skill/
│   ├── SKILL.md                    # Skill 元数据和命令映射
│   ├── references/
│   │   └── install.md             # 详细安装指南
│   └── extension/                  # 主插件代码
│       ├── README.md              # 完整用户文档
│       ├── package.json           # 插件依赖
│       ├── index.ts               # 插件入口点
│       ├── openclaw.plugin.json   # OpenClaw 插件配置
│       └── src/
│           ├── types.ts           # TypeScript 类型定义
│           ├── config.ts          # 配置管理
│           ├── http-handler.ts    # HTTP 请求处理
│           ├── transform.ts       # 消息格式转换
│           ├── lingzhu-tools.ts   # 设备工具定义
│           └── cli.ts             # CLI 命令注册
```

### 文档

- **[安装指南](skill/references/install.md)**：与灵珠平台集成的分步说明
- **[插件 README](skill/extension/README.md)**：详细配置、使用和 API 参考
- **[Skill 元数据](skill/SKILL.md)**：设备命令映射和要求

### 设备命令

| OpenClaw 工具 | 灵珠命令 | 说明 |
|--------------|----------|------|
| take_photo, camera, photo | take_photo | 相机控制 |
| navigate, navigation, maps | take_navigation | GPS 导航 |
| calendar, schedule, reminder | control_calendar | 日程/提醒 |
| exit, quit | notify_agent_off | 退出智能体会话 |

### 技术栈

- **语言**：TypeScript
- **运行时**：Node.js（ES 模块）
- **CLI 框架**：Commander.js
- **API 格式**：OpenAI 兼容的聊天补全

### 许可证

MIT
