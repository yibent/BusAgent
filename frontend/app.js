(() => {
  const thread = document.getElementById("thread");
  const statusEl = document.getElementById("status");
  const micBtn = document.getElementById("mic");
  const ring = document.getElementById("mic-ring");
  const form = document.getElementById("form");
  const input = document.getElementById("input");

  const conversationId = crypto.randomUUID();
  let ws = null;
  let listening = false;
  let audio = { stream: null, ctx: null, processor: null };
  let userBubble = null;
  let assistantBubble = null;
  let committed = "";
  let currentTurn = 0;
  let playing = false;
  let ignoreSpeech = false;

  const player = createPcmPlayer(() => {
    playing = false;
    notifySpeechEnded();
    restoreStatus();
  });

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  function restoreStatus() {
    if (listening) {
      setStatus("listening", "正在听");
    } else {
      setStatus("idle", "就绪");
    }
  }

  function addBubble(role, text) {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    el.textContent = text;
    thread.append(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function dropEmptyUserBubble() {
    if (userBubble && userBubble.textContent.trim().length === 0 && !userBubble.querySelector(".stash")) {
      userBubble.remove();
      userBubble = null;
    }
  }

  function downsample(samples, inRate, outRate) {
    if (inRate === outRate) {
      return samples;
    }
    const ratio = inRate / outRate;
    const outLen = Math.round(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      out[i] = samples[Math.floor(i * ratio)] || 0;
    }
    return out;
  }

  function floatTo16(float32) {
    const buf = new ArrayBuffer(float32.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < float32.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buf;
  }

  function rms(float32) {
    let sum = 0;
    for (let i = 0; i < float32.length; i += 1) {
      sum += float32[i] * float32[i];
    }
    return Math.sqrt(sum / Math.max(float32.length, 1));
  }

  function createPcmPlayer(onEnded) {
    let ctx = null;
    let sampleRate = 24000;
    let nextTime = 0;
    let active = 0;
    let endedTimer = 0;
    let generation = 0;

    function ensure() {
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext({ sampleRate });
        nextTime = 0;
      }
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      return ctx;
    }

    function finishIfIdle(gen) {
      if (gen !== generation || active > 0) {
        return;
      }
      window.clearTimeout(endedTimer);
      endedTimer = window.setTimeout(() => {
        if (gen === generation && active === 0) {
          onEnded();
        }
      }, 80);
    }

    return {
      configure(rate) {
        if (typeof rate === "number" && rate > 0 && rate !== sampleRate) {
          sampleRate = rate;
          generation += 1;
          if (ctx && ctx.state !== "closed") {
            void ctx.close();
          }
          ctx = null;
          nextTime = 0;
        }
      },
      playBase64(b64) {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const samples = Math.floor(bytes.byteLength / 2);
        if (samples <= 0) {
          return;
        }
        const audioCtx = ensure();
        const float32 = new Float32Array(samples);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samples; i += 1) {
          float32[i] = view.getInt16(i * 2, true) / 0x8000;
        }
        const buffer = audioCtx.createBuffer(1, samples, sampleRate);
        buffer.copyToChannel(float32, 0);
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        const startAt = Math.max(audioCtx.currentTime, nextTime);
        const gen = generation;
        src.start(startAt);
        nextTime = startAt + buffer.duration;
        active += 1;
        src.onended = () => {
          if (gen !== generation) {
            return;
          }
          active -= 1;
          finishIfIdle(gen);
        };
      },
      stop() {
        generation += 1;
        active = 0;
        nextTime = 0;
        window.clearTimeout(endedTimer);
        if (ctx && ctx.state !== "closed") {
          void ctx.close();
        }
        ctx = null;
      },
    };
  }

  function staleTurn(msg) {
    return typeof msg.turn === "number" && msg.turn !== currentTurn;
  }

  function notifySpeechEnded() {
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: "speech.ended",
        correlation_id: conversationId,
      }),
    );
  }

  function ensureSocket() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      return Promise.resolve(ws);
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/v1/stt`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      handleMessage(JSON.parse(event.data));
    };
    ws.onclose = () => {
      ws = null;
      if (listening) {
        setStatus("idle", "连接已关闭");
      }
    };
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("无法连接服务器"));
    });
  }

  function handleMessage(msg) {
    if (msg.type === "session.ready") {
      if (!playing) {
        setStatus("listening", "正在听");
      }
      return;
    }
    if (msg.type === "transcript.delta") {
      if (playing) {
        return;
      }
      if (!userBubble) {
        userBubble = addBubble("user", "");
        committed = "";
      }
      if (msg.committed) {
        committed += msg.text;
        userBubble.textContent = committed;
      } else {
        userBubble.innerHTML = `${escapeHtml(committed)}<span class="stash">${escapeHtml(msg.text)}</span>`;
      }
      thread.scrollTop = thread.scrollHeight;
      return;
    }
    if (msg.type === "transcript.final") {
      if (playing) {
        dropEmptyUserBubble();
        return;
      }
      committed = msg.text;
      if (!userBubble) {
        userBubble = addBubble("user", committed);
      } else {
        userBubble.textContent = committed;
      }
      userBubble = null;
      assistantBubble = null;
      setStatus("thinking", "思考中");
      return;
    }
    if (msg.type === "reply.start") {
      currentTurn = msg.turn ?? currentTurn + 1;
      ignoreSpeech = false;
      assistantBubble = addBubble("assistant", "");
      assistantBubble.classList.add("pending");
      setStatus("thinking", "正在回答");
      return;
    }
    if (msg.type === "reply.delta") {
      if (staleTurn(msg)) {
        return;
      }
      if (!assistantBubble) {
        assistantBubble = addBubble("assistant", "");
      }
      assistantBubble.classList.remove("pending");
      assistantBubble.textContent += msg.text;
      thread.scrollTop = thread.scrollHeight;
      setStatus("thinking", "正在回答");
      return;
    }
    if (msg.type === "reply.final") {
      if (staleTurn(msg)) {
        return;
      }
      if (!assistantBubble) {
        assistantBubble = addBubble("assistant", msg.text);
      } else {
        assistantBubble.classList.remove("pending");
        assistantBubble.textContent = msg.text;
      }
      assistantBubble = null;
      if (!playing) {
        restoreStatus();
      }
      return;
    }
    if (msg.type === "speech.start") {
      if (ignoreSpeech || staleTurn(msg)) {
        return;
      }
      playing = true;
      dropEmptyUserBubble();
      player.configure(msg.sample_rate || 24000);
      setStatus("thinking", "正在说话");
      return;
    }
    if (msg.type === "speech.audio") {
      if (ignoreSpeech || staleTurn(msg)) {
        return;
      }
      playing = true;
      player.playBase64(msg.audio);
      setStatus("thinking", "正在说话");
      return;
    }
    if (msg.type === "speech.done") {
      return;
    }
    if (msg.type === "error") {
      setStatus("error", msg.message || "出错了");
      addBubble("notice", msg.message || "出错了");
    }
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  async function startListening() {
    committed = "";
    userBubble = null;
    setStatus("idle", "连接中…");
    const socket = await ensureSocket();
    socket.send(
      JSON.stringify({
        type: "session.start",
        correlation_id: conversationId,
        language: "zh",
        sample_rate: 16000,
        encoding: "pcm",
      }),
    );
    audio.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audio.ctx = new AudioContext();
    const source = audio.ctx.createMediaStreamSource(audio.stream);
    audio.processor = audio.ctx.createScriptProcessor(4096, 1, 1);
    const mute = audio.ctx.createGain();
    mute.gain.value = 0;
    audio.processor.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== 1) {
        return;
      }
      const inputData = event.inputBuffer.getChannelData(0);
      ring.style.setProperty("--level", String(Math.min(1, rms(inputData) * 8)));
      ws.send(floatTo16(downsample(inputData, audio.ctx.sampleRate, 16000)));
    };
    source.connect(audio.processor);
    audio.processor.connect(mute);
    mute.connect(audio.ctx.destination);
    listening = true;
    micBtn.setAttribute("aria-pressed", "true");
    if (!playing) {
      setStatus("listening", "正在听");
    }
  }

  async function stopListening() {
    listening = false;
    micBtn.setAttribute("aria-pressed", "false");
    ring.style.setProperty("--level", "0");
    if (audio.processor) {
      audio.processor.disconnect();
    }
    if (audio.ctx) {
      await audio.ctx.close();
    }
    if (audio.stream) {
      audio.stream.getTracks().forEach((track) => track.stop());
    }
    audio = { stream: null, ctx: null, processor: null };
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "audio.done" }));
    }
    dropEmptyUserBubble();
    if (playing) {
      setStatus("thinking", "正在说话");
    } else if (userBubble && userBubble.textContent.trim().length > 0) {
      setStatus("thinking", "思考中");
    } else {
      setStatus("idle", "就绪");
    }
  }

  async function toggleMic() {
    try {
      if (listening) {
        await stopListening();
      } else {
        await startListening();
      }
    } catch (error) {
      setStatus("error", error.message || String(error));
      await stopListening().catch(() => undefined);
    }
  }

  async function sendText(text) {
    player.stop();
    playing = false;
    ignoreSpeech = true;
    notifySpeechEnded();
    addBubble("user", text);
    assistantBubble = null;
    setStatus("thinking", "思考中");
    const socket = await ensureSocket();
    socket.send(
      JSON.stringify({
        type: "user.text",
        correlation_id: conversationId,
        text,
      }),
    );
  }

  micBtn.addEventListener("click", () => {
    void toggleMic();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) {
      return;
    }
    input.value = "";
    void sendText(text).catch((error) => {
      setStatus("error", error.message || String(error));
    });
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && event.target === document.body) {
      event.preventDefault();
      void toggleMic();
    }
  });
  void ensureSocket().catch(() => undefined);
})();
