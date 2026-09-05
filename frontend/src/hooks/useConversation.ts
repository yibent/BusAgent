import { useCallback, useEffect, useRef, useState } from "react";
import { createPcmPlayer, type PcmPlayer } from "../lib/pcm-player";

export type MessageRole = "user" | "assistant" | "notice";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  pending?: boolean;
}

export interface RobotBusEvent {
  id: string;
  eventType: string;
  sourceAgentId: string;
  taskId?: string;
  taskVersion?: number;
  createdAt: number;
  payload: Record<string, unknown>;
}

type Activity =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

interface ServerMessage {
  type?: string;
  text?: string;
  message?: string;
  committed?: boolean;
  turn?: number;
  sample_rate?: number;
  audio?: string;
  event_id?: string;
  event_type?: string;
  source_agent_id?: string;
  task_id?: string;
  task_version?: number;
  created_at?: string;
  payload?: unknown;
}

interface CaptureState {
  stream: MediaStream | null;
  context: AudioContext | null;
  processor: ScriptProcessorNode | null;
}

const EMPTY_CAPTURE: CaptureState = {
  stream: null,
  context: null,
  processor: null,
};

function websocketUrl(): string {
  const configured = import.meta.env.VITE_BUSAGENT_WS_URL?.trim();
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/v1/stt`;
}

function downsample(
  samples: Float32Array,
  inputRate: number,
  outputRate: number,
) {
  if (inputRate === outputRate) return samples;
  const ratio = inputRate / outputRate;
  const result = new Float32Array(Math.round(samples.length / ratio));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = samples[Math.floor(index * ratio)] ?? 0;
  }
  return result;
}

function toPcm16(samples: Float32Array) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  });
  return buffer;
}

function rms(samples: Float32Array) {
  let sum = 0;
  samples.forEach((sample) => {
    sum += sample * sample;
  });
  return Math.sqrt(sum / Math.max(samples.length, 1));
}

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [activity, setActivity] = useState<Activity>("connecting");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [micBusy, setMicBusy] = useState(false);
  const [robotEvents, setRobotEvents] = useState<RobotBusEvent[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const socketPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());
  const captureRef = useRef<CaptureState>(EMPTY_CAPTURE);
  const listeningRef = useRef(false);
  const speakingRef = useRef(false);
  const ignoreSpeechRef = useRef(false);
  const ignoredReplyTurnRef = useRef<number | null>(null);
  const currentTurnRef = useRef(0);
  const transcriptIdRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const committedTranscriptRef = useRef("");
  const playerRef = useRef<PcmPlayer | null>(null);

  const appendMessage = useCallback(
    (role: MessageRole, text: string, pending = false) => {
      const message: ConversationMessage = {
        id: crypto.randomUUID(),
        role,
        text,
        createdAt: Date.now(),
        ...(pending ? { pending: true } : {}),
      };
      setMessages((current) => [...current, message]);
      return message.id;
    },
    [],
  );

  const updateMessage = useCallback(
    (
      id: string,
      changes: Partial<Pick<ConversationMessage, "text" | "pending">>,
    ) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, ...changes } : message,
        ),
      );
    },
    [],
  );

  const sendSpeechEnded = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "speech.ended",
          correlation_id: conversationIdRef.current,
        }),
      );
    }
  }, []);

  if (playerRef.current === null) {
    playerRef.current = createPcmPlayer(() => {
      speakingRef.current = false;
      setIsSpeaking(false);
      sendSpeechEnded();
      setActivity(listeningRef.current ? "listening" : "idle");
    });
  }

  const releaseCapture = useCallback(() => {
    const capture = captureRef.current;
    capture.processor?.disconnect();
    if (capture.context !== null && capture.context.state !== "closed") {
      void capture.context.close();
    }
    capture.stream?.getTracks().forEach((track) => track.stop());
    captureRef.current = EMPTY_CAPTURE;
    listeningRef.current = false;
    setIsListening(false);
    setVoiceLevel(0);
  }, []);

  const isStaleTurn = useCallback((message: ServerMessage) => {
    return (
      typeof message.turn === "number" &&
      message.turn !== currentTurnRef.current
    );
  }, []);

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "bus.event": {
          if (!message.event_type) return;
          const payload =
            message.payload !== null && typeof message.payload === "object"
              ? (message.payload as Record<string, unknown>)
              : {};
          const event: RobotBusEvent = {
            id: message.event_id ?? crypto.randomUUID(),
            eventType: message.event_type,
            sourceAgentId: message.source_agent_id ?? "system",
            ...(message.task_id ? { taskId: message.task_id } : {}),
            ...(typeof message.task_version === "number"
              ? { taskVersion: message.task_version }
              : {}),
            createdAt: message.created_at
              ? new Date(message.created_at).getTime()
              : Date.now(),
            payload,
          };
          setRobotEvents((current) => [event, ...current].slice(0, 60));
          return;
        }
        case "session.ready":
          setActivity("listening");
          return;
        case "transcript.delta": {
          if (speakingRef.current) return;
          if (transcriptIdRef.current === null) {
            transcriptIdRef.current = appendMessage("user", "");
            committedTranscriptRef.current = "";
          }
          if (message.committed)
            committedTranscriptRef.current += message.text ?? "";
          updateMessage(transcriptIdRef.current, {
            text: `${committedTranscriptRef.current}${message.committed ? "" : (message.text ?? "")}`,
            pending: !message.committed,
          });
          return;
        }
        case "transcript.final": {
          if (speakingRef.current) return;
          const finalText = message.text?.trim() ?? "";
          if (finalText.length > 0) {
            if (transcriptIdRef.current === null) {
              appendMessage("user", finalText);
            } else {
              updateMessage(transcriptIdRef.current, {
                text: finalText,
                pending: false,
              });
            }
          }
          transcriptIdRef.current = null;
          committedTranscriptRef.current = "";
          assistantIdRef.current = null;
          setActivity("thinking");
          return;
        }
        case "reply.start":
          currentTurnRef.current = message.turn ?? currentTurnRef.current + 1;
          ignoreSpeechRef.current = false;
          ignoredReplyTurnRef.current = null;
          assistantIdRef.current = appendMessage("assistant", "", true);
          setActivity("thinking");
          return;
        case "reply.delta":
          if (
            isStaleTurn(message) ||
            message.turn === ignoredReplyTurnRef.current
          )
            return;
          if (assistantIdRef.current === null) {
            assistantIdRef.current = appendMessage(
              "assistant",
              message.text ?? "",
            );
          } else {
            const id = assistantIdRef.current;
            setMessages((current) =>
              current.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      text: `${item.text}${message.text ?? ""}`,
                      pending: false,
                    }
                  : item,
              ),
            );
          }
          setActivity(speakingRef.current ? "speaking" : "thinking");
          return;
        case "reply.final":
          if (
            isStaleTurn(message) ||
            message.turn === ignoredReplyTurnRef.current
          )
            return;
          if (assistantIdRef.current === null) {
            appendMessage("assistant", message.text ?? "");
          } else {
            updateMessage(assistantIdRef.current, {
              text: message.text ?? "",
              pending: false,
            });
          }
          assistantIdRef.current = null;
          if (!speakingRef.current)
            setActivity(listeningRef.current ? "listening" : "idle");
          return;
        case "speech.start":
          if (ignoreSpeechRef.current || isStaleTurn(message)) return;
          speakingRef.current = true;
          setIsSpeaking(true);
          playerRef.current?.configure(message.sample_rate ?? 24_000);
          setActivity("speaking");
          return;
        case "speech.audio":
          if (ignoreSpeechRef.current || isStaleTurn(message) || !message.audio)
            return;
          speakingRef.current = true;
          setIsSpeaking(true);
          playerRef.current?.playBase64(message.audio);
          setActivity("speaking");
          return;
        case "speech.interrupted":
          ignoredReplyTurnRef.current = currentTurnRef.current;
          ignoreSpeechRef.current = true;
          speakingRef.current = false;
          setIsSpeaking(false);
          playerRef.current?.stop();
          if (assistantIdRef.current !== null) {
            updateMessage(assistantIdRef.current, { pending: false });
            assistantIdRef.current = null;
          }
          setActivity(listeningRef.current ? "listening" : "idle");
          return;
        case "error":
          setActivity("error");
          appendMessage(
            "notice",
            message.message || "请求处理失败，请稍后再试。",
          );
          return;
        default:
          return;
      }
    },
    [appendMessage, isStaleTurn, updateMessage],
  );

  const ensureSocket = useCallback(() => {
    const current = socketRef.current;
    if (current?.readyState === WebSocket.OPEN) return Promise.resolve(current);
    if (socketPromiseRef.current !== null) return socketPromiseRef.current;

    setActivity("connecting");
    const socket = new WebSocket(websocketUrl());
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const promise = new Promise<WebSocket>((resolve, reject) => {
      let opened = false;
      socket.addEventListener(
        "open",
        () => {
          opened = true;
          resolve(socket);
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("无法连接 BusAgent 后端")),
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          if (!opened) reject(new Error("BusAgent 后端连接已关闭"));
        },
        { once: true },
      );
    });
    socketPromiseRef.current = promise;
    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        appendMessage("notice", "收到了无法解析的服务器消息。");
      }
    };
    socket.onopen = () => setActivity("idle");
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      socketPromiseRef.current = null;
      if (listeningRef.current) releaseCapture();
      if (!speakingRef.current) setActivity("error");
    };
    return promise.finally(() => {
      if (socketPromiseRef.current === promise) socketPromiseRef.current = null;
    });
  }, [appendMessage, handleMessage, releaseCapture]);

  const stopSpeaking = useCallback(() => {
    ignoreSpeechRef.current = true;
    speakingRef.current = false;
    setIsSpeaking(false);
    playerRef.current?.stop();
    sendSpeechEnded();
    setActivity(listeningRef.current ? "listening" : "idle");
  }, [sendSpeechEnded]);

  const startListening = useCallback(async () => {
    setMicBusy(true);
    let requestedStream: MediaStream | null = null;
    try {
      if (speakingRef.current) stopSpeaking();
      requestedStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const socket = await ensureSocket();
      socket.send(
        JSON.stringify({
          type: "session.start",
          correlation_id: conversationIdRef.current,
          language: "zh",
          sample_rate: 16_000,
          encoding: "pcm",
        }),
      );

      const context = new AudioContext();
      const source = context.createMediaStreamSource(requestedStream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const activeSocket = socketRef.current;
        if (activeSocket?.readyState !== WebSocket.OPEN) return;
        const samples = event.inputBuffer.getChannelData(0);
        setVoiceLevel(Math.min(1, rms(samples) * 8));
        activeSocket.send(
          toPcm16(downsample(samples, context.sampleRate, 16_000)),
        );
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      captureRef.current = { stream: requestedStream, context, processor };
      listeningRef.current = true;
      setIsListening(true);
      setActivity("listening");
    } catch (error) {
      requestedStream?.getTracks().forEach((track) => track.stop());
      releaseCapture();
      setActivity("error");
      appendMessage(
        "notice",
        error instanceof Error ? error.message : "无法启动麦克风。",
      );
    } finally {
      setMicBusy(false);
    }
  }, [appendMessage, ensureSocket, releaseCapture, stopSpeaking]);

  const stopListening = useCallback(() => {
    releaseCapture();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.done" }));
    }
    setActivity(speakingRef.current ? "speaking" : "idle");
  }, [releaseCapture]);

  const toggleListening = useCallback(() => {
    if (micBusy) return Promise.resolve();
    return listeningRef.current
      ? Promise.resolve(stopListening())
      : startListening();
  }, [micBusy, startListening, stopListening]);

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text) return;
      if (speakingRef.current) stopSpeaking();
      ignoreSpeechRef.current = true;
      appendMessage("user", text);
      assistantIdRef.current = null;
      setActivity("thinking");
      try {
        const socket = await ensureSocket();
        socket.send(
          JSON.stringify({
            type: "user.text",
            correlation_id: conversationIdRef.current,
            text,
          }),
        );
      } catch (error) {
        setActivity("error");
        appendMessage(
          "notice",
          error instanceof Error ? error.message : "消息发送失败。",
        );
      }
    },
    [appendMessage, ensureSocket, stopSpeaking],
  );

  const startNewConversation = useCallback(() => {
    releaseCapture();
    playerRef.current?.stop();
    const oldSocket = socketRef.current;
    socketRef.current = null;
    socketPromiseRef.current = null;
    oldSocket?.close();
    conversationIdRef.current = crypto.randomUUID();
    transcriptIdRef.current = null;
    assistantIdRef.current = null;
    committedTranscriptRef.current = "";
    currentTurnRef.current = 0;
    ignoredReplyTurnRef.current = null;
    speakingRef.current = false;
    ignoreSpeechRef.current = false;
    setIsSpeaking(false);
    setMessages([]);
    setRobotEvents([]);
    setActivity("connecting");
    void ensureSocket().catch(() => setActivity("error"));
  }, [ensureSocket, releaseCapture]);

  useEffect(() => {
    let active = true;
    void ensureSocket().catch(() => {
      if (active) setActivity("error");
    });
    return () => {
      active = false;
      releaseCapture();
      playerRef.current?.stop();
      const socket = socketRef.current;
      socketRef.current = null;
      socketPromiseRef.current = null;
      socket?.close();
    };
  }, [ensureSocket, releaseCapture]);

  return {
    messages,
    activity,
    isListening,
    isSpeaking,
    micBusy,
    voiceLevel,
    robotEvents,
    sendText,
    toggleListening,
    stopSpeaking,
    startNewConversation,
  };
}
