import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUp,
  Keyboard,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  VolumeX,
  X,
} from "lucide-react";
import type { useConversation } from "@/hooks/useConversation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
export function VoiceOrb({
  conversation,
  onHistory,
  disabled,
}: {
  conversation: ReturnType<typeof useConversation>;
  onHistory: () => void;
  disabled: boolean;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [time, setTime] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);
  const replies = conversation.messages
    .filter(
      (m) =>
        m.role !== "user" &&
        (m.pending || time - (m.updatedAt ?? m.createdAt) < 20000),
    )
    .slice(-2);
  const active =
    conversation.isListening ||
    conversation.isSpeaking ||
    conversation.activity === "thinking";
  const status = conversation.isListening
    ? "正在聆听，再次点击结束"
    : conversation.isSpeaking
      ? "正在回复"
      : conversation.activity === "thinking"
        ? "正在处理"
        : "点击说话";
  const submit = () => {
    if (text.trim()) {
      void conversation.sendText(text);
      setText("");
      setTyping(false);
    }
  };
  return (
    <aside
      className={`voice-dock ${typing ? "is-typing" : ""} ${active ? "is-active" : ""}`}
      aria-label="刘工语音助手"
    >
      <div className="reply-bubbles" aria-live="polite">
        {replies.map((m, i) => (
          <div
            className={`reply-bubble ${m.role === "notice" ? "notice-bubble" : ""}`}
            style={{
              opacity:
                i < replies.length - 1
                  ? 0.5
                  : m.pending
                    ? 1
                    : Math.min(
                        1,
                        Math.max(
                          0,
                          (20000 - (time - (m.updatedAt ?? m.createdAt))) /
                            5000,
                        ),
                      ),
            }}
            key={m.id}
          >
            <span className="bubble-avatar">刘</span>
            <p>{m.text || "正在思考…"}</p>
          </div>
        ))}
      </div>
      {typing && (
        <form
          className="orb-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="告诉刘工，你想做什么…"
            aria-label="输入任务"
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTyping(false);
            }}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!text.trim() || disabled}
            aria-label="发送任务"
          >
            <ArrowUp />
          </Button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTyping(false)}
            aria-label="关闭输入"
          >
            <X size={14} />
          </button>
        </form>
      )}
      <div className="orb-hover-tools">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setTyping(!typing)}
          disabled={disabled}
        >
          <Keyboard />
          文字输入
        </Button>
        <Button
          variant="secondary"
          size="icon"
          aria-label="查看对话"
          onClick={onHistory}
        >
          <MessageSquareText />
        </Button>
        {conversation.isSpeaking && (
          <Button
            variant="secondary"
            size="icon"
            onClick={conversation.stopSpeaking}
            aria-label="停止播报"
          >
            <VolumeX />
          </Button>
        )}
      </div>
      <button
        className="voice-orb"
        style={{ "--voice-level": conversation.voiceLevel } as CSSProperties}
        onClick={() => void conversation.toggleListening()}
        aria-label={conversation.isListening ? "结束说话" : "开始说话"}
        aria-pressed={conversation.isListening}
        disabled={disabled || conversation.micBusy}
        title={disabled ? "先选择场景并进入仿真" : status}
      >
        <span className="orb-halo" />
        <span className="orb-core">
          {conversation.micBusy || conversation.activity === "thinking" ? (
            <Loader2 size={22} className="animate-spin" />
          ) : conversation.isListening ? (
            <>
              <span className="voice-wave">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <MicOff className="orb-stop" size={18} />
            </>
          ) : (
            <Mic size={23} strokeWidth={1.6} />
          )}
        </span>
      </button>
      <span className="orb-status">{status}</span>
    </aside>
  );
}
