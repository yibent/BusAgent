# BusAgent 前端

语音聊天助手。页面由 Host 托管，打开 `http://localhost:3000/`。

可以说，也可以打字。助手用通义千问生成文字，再用 Qwen-TTS 合成语音。说话时麦克风可以继续开着，回采到的助手声音不会进入对话。

```bash
docker compose up -d mysql
cd backend
pnpm dev
```
