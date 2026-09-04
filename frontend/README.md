# BusAgent 前端

独立的 React + Vite 前端。首页展示当前可用的 App，对话助手支持文字、实时语音转写和语音播放。录音保持开启时，用户可以在助手播报期间直接说话打断；浏览器会开启回声消除，后端还会根据当前播报文本过滤回麦。

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

打开 [http://localhost:5173](http://localhost:5173)。Vite 开发服务器会将 `/v1/stt` WebSocket 代理到 `localhost:3000`。

## 生产构建

```bash
pnpm build
pnpm preview
```

构建产物位于 `frontend/dist/`。前端和后端分开部署时，通过 `VITE_BUSAGENT_WS_URL` 指定完整的后端 WebSocket 地址：

```bash
VITE_BUSAGENT_WS_URL=wss://api.example.com/v1/stt pnpm build
```

SPA 托管端需要将未匹配路由回退到 `index.html`，以便直接访问 `/apps/dialogue`。
