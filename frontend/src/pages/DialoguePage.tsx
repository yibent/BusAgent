import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  BackIcon,
  MessageIcon,
  MicIcon,
  PlusIcon,
  SendIcon,
  SparkleIcon,
  StopIcon,
} from '../components/Icons';
import { useConversation } from '../hooks/useConversation';

const suggestions = ['你可以做什么？', '帮我规划今天的任务', '请简单介绍 BusAgent'];

const statusText = {
  idle: '已连接',
  connecting: '连接中',
  listening: '正在听 · 停顿后发送',
  thinking: '正在思考',
  speaking: '正在说话 · 可直接打断',
  error: '出现问题',
} as const;

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

export function DialoguePage() {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    activity,
    isListening,
    isSpeaking,
    micBusy,
    voiceLevel,
    sendText,
    toggleListening,
    stopSpeaking,
    startNewConversation,
  } = useConversation();

  useEffect(() => {
    const element = threadRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void sendText(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const newConversation = () => {
    startNewConversation();
    setDraft('');
    textareaRef.current?.focus();
  };

  return (
    <main className="dialogue-shell">
      <header className="dialogue-header">
        <div className="dialogue-header-main">
          <Link className="icon-button subtle" to="/" aria-label="返回 App 首页">
            <BackIcon />
          </Link>
          <div className="dialogue-avatar" aria-hidden="true">
            <MessageIcon />
          </div>
          <div className="dialogue-title">
            <h1>对话助手</h1>
            <span className={`live-status ${activity}`}>
              <i />
              {statusText[activity]}
            </span>
          </div>
        </div>
        <button className="new-chat-button" type="button" onClick={newConversation}>
          <PlusIcon />
          <span>新对话</span>
        </button>
      </header>

      <section className="conversation-panel">
        <div className="message-thread" ref={threadRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="empty-icon">
                <SparkleIcon />
              </span>
              <h2>你好，有什么可以帮你？</h2>
              <p>可以直接输入文字，也可以打开麦克风语音对话。</p>
              <div className="suggestion-list">
                {suggestions.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => void sendText(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id}>
                  {message.role === 'assistant' && (
                    <span className="message-avatar" aria-hidden="true">
                      <SparkleIcon />
                    </span>
                  )}
                  <div className="message-stack">
                    <div className={`message-bubble ${message.pending ? 'pending' : ''}`}>
                      {message.text}
                      {message.pending && !message.text && (
                        <span className="typing-dots" aria-label="正在生成回复">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </div>
                    {message.role !== 'notice' && (
                      <time dateTime={new Date(message.createdAt).toISOString()}>
                        {formatTime(message.createdAt)}
                      </time>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <footer className="composer-wrap">
          {isSpeaking && (
            <button className="stop-speaking" type="button" onClick={stopSpeaking}>
              <StopIcon />
              停止播放
            </button>
          )}
          <div className="composer">
            <button
              className={`mic-button ${isListening ? 'active' : ''}`}
              type="button"
              aria-label={isListening ? '停止语音输入' : '开始语音输入'}
              aria-pressed={isListening}
              disabled={micBusy}
              onClick={() => void toggleListening()}
              style={{ '--voice-level': voiceLevel } as CSSProperties}
            >
              <span className="voice-ring" />
              {isListening ? <StopIcon /> : <MicIcon />}
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              placeholder={isListening ? '正在倾听，可以自然停顿…' : '输入消息…'}
              aria-label="消息内容"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="send-button"
              type="button"
              aria-label="发送消息"
              disabled={!draft.trim()}
              onClick={submit}
            >
              <SendIcon />
            </button>
          </div>
          <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>
        </footer>
      </section>
    </main>
  );
}
