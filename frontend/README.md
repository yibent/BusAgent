# BusAgent 前端

独立的 React + Vite 前端。机器人操作台支持文字指令、实时语音转写、语音播放、BusAgent 节点事件、任务执行链和 Isaac 控制器状态。录音保持开启时，用户可以在助手播报期间直接说话打断；浏览器会开启回声消除，后端还会根据当前播报文本过滤回麦。

操作台不传输相机画面。Isaac Sim 的渲染效果直接通过 GPU 服务器显示器查看，Web 页面只承载交互和状态，因此不会占用额外的视频编码与网络带宽。

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

打开 [http://localhost:5173/apps/robot](http://localhost:5173/apps/robot)。Vite 开发服务器会将 `/v1/stt` WebSocket 和 `/v1/robot/status` 代理到 `localhost:3000`。

## 生产构建

```bash
pnpm build
pnpm preview
```

构建产物位于 `frontend/dist/`。建议在 GPU 服务器上由同一个 HTTPS 域名反向代理前端、`/v1/stt` 和 `/v1/robot/status`。如果前端和后端分开部署，通过环境变量指定地址：

```bash
VITE_BUSAGENT_WS_URL=wss://api.example.com/v1/stt \
VITE_BUSAGENT_HTTP_URL=https://api.example.com \
pnpm build
```

除 `localhost` 外，现代浏览器通常只允许网页在 HTTPS 安全上下文中使用麦克风。SPA 托管端还需将未匹配路由回退到 `index.html`，以便直接访问 `/apps/robot`。
