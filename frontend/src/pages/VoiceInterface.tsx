import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
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
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border/40 backdrop-blur-sm bg-background/80 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Mic className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">语音助手</h1>
              <p className="text-xs text-muted-foreground">{statusText[activity]}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={cn(
              "w-2 h-2 rounded-full transition-colors",
              activity === "idle" ? "bg-emerald-500" :
              activity === "error" ? "bg-destructive" :
              "bg-primary animate-pulse"
            )} />
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto" ref={threadRef}>
        <div className="max-w-3xl mx-auto px-6 py-8">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
                <Mic className="w-10 h-10 text-primary" />
              </div>
              <h2 className="text-2xl font-semibold mb-2 tracking-tight">
                开始对话
              </h2>
              <p className="text-muted-foreground text-sm max-w-md">
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
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Mic className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  <div className={cn(
                    "rounded-2xl px-4 py-3 max-w-[80%]",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-md"
                      : message.role === "notice"
                      ? "bg-destructive/10 text-destructive text-center text-sm"
                      : "bg-muted text-foreground rounded-tl-md"
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
      <footer className="border-t border-border/40 backdrop-blur-sm bg-background/80 sticky bottom-0">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex flex-col items-center gap-4">
            {isSpeaking && (
              <Button
                variant="outline"
                size="sm"
                onClick={stopSpeaking}
                className="rounded-full"
              >
                停止播放
              </Button>
            )}

            <button
              onClick={() => void toggleListening()}
              disabled={micBusy}
              className={cn(
                "relative w-20 h-20 rounded-full flex items-center justify-center transition-all disabled:opacity-50",
                isListening
                  ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground shadow-lg shadow-destructive/20"
                  : "bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
              )}
              style={{
                transform: isListening ? `scale(${1 + voiceLevel * 0.1})` : "scale(1)",
              }}
            >
              {isListening ? (
                <MicOff className="w-8 h-8" />
              ) : (
                <Mic className="w-8 h-8" />
              )}

              {isListening && (
                <div
                  className="absolute inset-0 rounded-full border-4 border-destructive/30 animate-ping"
                  style={{
                    opacity: voiceLevel * 0.8,
                  }}
                />
              )}
            </button>

            <p className="text-xs text-muted-foreground">
              {isListening ? "点击停止录音" : "点击开始语音对话"}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
