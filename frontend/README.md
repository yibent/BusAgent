# BusAgent 前端

使用 **shadcn/ui** 重构的简洁语音交互界面。专注于核心对话功能，提供流畅的语音输入体验。

## 技术栈

- **React 19** - UI 框架
- **Tailwind CSS v3** - 样式系统
- **shadcn/ui** - UI 组件库
- **Lucide React** - 图标库
- **Vite** - 构建工具

## 主要特性

### 🎙️ 简洁语音交互
- 大按钮式麦克风控制，易于操作
- 实时语音电平反馈（动画效果）
- 清晰的状态指示（就绪/连接中/正在听/思考中/正在说话/错误）

### 🎨 现代化设计
- 深色主题，减少视觉疲劳
- 流畅的动画和过渡效果
- 响应式布局，适配各种屏幕

### 💬 对话界面
- 清晰的消息气泡布局
- 用户消息靠右（蓝色）
- 助手消息靠左（灰色）
- 错误通知居中（红色）
- 自动滚动到最新消息

## 本地开发

先启动 MySQL 和后端：

```bash
docker compose up -d mysql
cd backend
pnpm install
pnpm dev
```

再在另一个终端启动前端：

```bash
cd frontend
pnpm install
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)（如果端口被占用会自动使用 5174）。Vite 开发服务器会将 `/v1/stt` WebSocket 代理到 `localhost:3000`。

## 生产构建

```bash
pnpm build
pnpm preview
```

构建产物位于 `frontend/dist/`。建议在 GPU 服务器上由同一个 HTTPS 域名反向代理前端和 `/v1/stt`。如果前端和后端分开部署，通过环境变量指定地址：

```bash
BUSAGENT_PROXY_TARGET=https://api.example.com \
pnpm build
```

除 `localhost` 外，现代浏览器通常只允许网页在 HTTPS 安全上下文中使用麦克风。SPA 托管端还需将未匹配路由回退到 `index.html`。

## 项目结构

```
src/
├── components/
│   └── ui/                 # shadcn/ui 组件
│       └── button.tsx
├── hooks/
│   └── useConversation.ts  # 对话逻辑 Hook
├── lib/
│   ├── pcm-player.ts       # PCM 音频播放器
│   └── utils.ts            # 工具函数
├── pages/
│   └── VoiceInterface.tsx  # 主语音界面
├── App.tsx
├── main.tsx
└── index.css               # Tailwind 样式
```

## 主要改进

1. **移除冗余功能** - 只保留核心语音交互，去除机器人控制台等复杂界面
2. **优化交互体验** - 大按钮、清晰状态、即时反馈
3. **统一设计语言** - 使用 shadcn/ui 组件系统，确保一致性
4. **性能优化** - 减少不必要的渲染，优化动画性能

## 浏览器要求

- 支持 WebRTC MediaDevices API（麦克风访问）
- 支持 WebSocket
- 支持 Web Audio API
- 建议使用 Chrome/Edge/Safari 最新版本
