import { useEffect, useRef } from "react";
import { Mic, MicOff, Loader2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConversation } from "@/hooks/useConversation";
import { cn } from "@/lib/utils";

const statusText = {
  idle: "就绪",
  connecting: "连接中",
  listening: "正在听",
  thinking: "思考中",
  speaking: "正在说话",
  error: "错误",
} as const;

export function VoiceInterface() {
  const threadRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    activity,
    isListening,
    isSpeaking,
    micBusy,
    voiceLevel,
    toggleListening,
    stopSpeaking,
  } = useConversation();

  useEffect(() => {
    const element = threadRef.current;
    if (element)
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50">
      {/* Header */}
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center">
              <Mic className="w-5 h-5 text-neutral-900" />
            </div>
            <div>
              <h1 className="text-sm font-semibold">语音助手</h1>
              <p className="text-xs text-neutral-500">{statusText[activity]}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Circle
              className={cn(
                "w-2 h-2 fill-current transition-colors",
                activity === "idle" ? "text-emerald-500" :
                activity === "error" ? "text-red-500" :
                "text-neutral-900 animate-pulse"
              )}
            />
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto bg-white" ref={threadRef}>
        <div className="max-w-4xl mx-auto px-6 py-8">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="w-20 h-20 rounded-xl bg-neutral-100 flex items-center justify-center mb-6">
                <Mic className="w-10 h-10 text-neutral-900" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">
                开始对话
              </h2>
              <p className="text-neutral-500 text-sm max-w-md">
                点击下方麦克风按钮开始语音对话
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex gap-3",
                    message.role === "user" && "justify-end"
                  )}
                >
                  {message.role === "assistant" && (
                    <div className="w-8 h-8 rounded-md bg-neutral-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Mic className="w-4 h-4 text-neutral-900" />
                    </div>
                  )}
                  <div className={cn(
                    "rounded-lg px-4 py-2.5 max-w-[75%] shadow-sm",
                    message.role === "user"
                      ? "bg-neutral-900 text-white"
                      : message.role === "notice"
                      ? "bg-red-50 text-red-600 border border-red-200 text-center text-sm"
                      : "bg-neutral-100 text-neutral-900"
                  )}>
                    {message.text || (message.pending && (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">思考中...</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Voice Control */}
      <footer className="border-t bg-white sticky bottom-0">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="flex flex-col items-center gap-4">
            {isSpeaking && (
              <Button
                variant="outline"
                size="sm"
                onClick={stopSpeaking}
                className="rounded-md"
              >
                停止播放
              </Button>
            )}

            <button
              onClick={() => void toggleListening()}
              disabled={micBusy}
              className={cn(
                "relative w-16 h-16 rounded-full flex items-center justify-center transition-all disabled:opacity-50 shadow-lg",
                isListening
                  ? "bg-red-500 hover:bg-red-600 text-white"
                  : "bg-neutral-900 hover:bg-neutral-800 text-white"
              )}
              style={{
                transform: isListening ? `scale(${1 + voiceLevel * 0.08})` : "scale(1)",
              }}
            >
              {isListening ? (
                <MicOff className="w-7 h-7" />
              ) : (
                <Mic className="w-7 h-7" />
              )}

              {isListening && (
                <div
                  className="absolute inset-0 rounded-full border-2 border-red-300 animate-ping"
                  style={{
                    opacity: voiceLevel * 0.6,
                  }}
                />
              )}
            </button>

            <p className="text-xs text-neutral-500">
              {isListening ? "点击停止录音" : "点击开始语音对话"}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
