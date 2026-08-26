"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { RobinMessage, RobinAction, RobinChatSession } from "@/types";
import Navbar from "@/components/Navbar";
import { useSession } from "next-auth/react";
import Link from "next/link";

const GREETING: RobinMessage = {
  role: "assistant",
  content:
    "Hey! I'm Robin 👋 I have full context of your goals, tasks, and recent emails. Ask me what to focus on, or tell me to update a deadline, priority, or create a task.",
};

const PROMPTS = [
  "What should I work on today?",
  "What's overdue or at risk?",
  "Summarize my tasks by priority",
  "What emails need my attention?",
];

const SESSIONS_STORAGE_KEY = "workbudi_robin_sessions_v5";
const ACTIVE_SESSION_KEY = "workbudi_robin_active_session_id_v5";

function createNewSession(indexNumber = 1): RobinChatSession {
  return {
    id: "session_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    title: `Session ${indexNumber}`,
    messages: [GREETING],
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export default function RobinPage() {
  const { data: session } = useSession();
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [sessions, setSessions] = useState<RobinChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleInput, setEditTitleInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string>("🔍 Contacting Robin AI…");
  const [pendingClarificationCount, setPendingClarificationCount] = useState(0);
  const isSendingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Detect mobile viewport and initialize state
  useEffect(() => {
    setMounted(true);
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    try {
      const savedSessions = localStorage.getItem(SESSIONS_STORAGE_KEY);
      const savedActiveId = localStorage.getItem(ACTIVE_SESSION_KEY);

      if (savedSessions) {
        const parsed: RobinChatSession[] = JSON.parse(savedSessions);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSessions(parsed);
          const found = parsed.find((s) => s.id === savedActiveId);
          setActiveSessionId(found ? found.id : parsed[0].id);
          return;
        }
      }
    } catch {
      // Fallback
    }

    const initial = createNewSession(1);
    setSessions([initial]);
    setActiveSessionId(initial.id);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Poll for pending clarifications (so the badge stays fresh)
  useEffect(() => {
    async function fetchClarifications() {
      try {
        const res = await fetch("/api/clarifications");
        if (res.ok) {
          const data = await res.json();
          setPendingClarificationCount(Array.isArray(data) ? data.length : 0);
        }
      } catch {
        // Ignore — non-critical
      }
    }
    fetchClarifications();
    // Refresh every 60s so new clarifications from background polls surface
    const interval = setInterval(fetchClarifications, 60000);
    return () => clearInterval(interval);
  }, []);

  // Save sessions to localStorage on state change
  useEffect(() => {
    if (mounted && sessions.length > 0) {
      try {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
        localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
      } catch {
        // Ignore storage errors
      }
    }
  }, [sessions, activeSessionId, mounted]);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0] || createNewSession(1);
  const messages = activeSession ? activeSession.messages : [GREETING];

  useEffect(() => {
    if (mounted) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, liveStatus, mounted]);

  function handleNewChat() {
    const nextNum = sessions.length + 1;
    const newSess = createNewSession(nextNum);
    setSessions((prev) => [newSess, ...prev]);
    setActiveSessionId(newSess.id);
    setInput("");
    if (isMobile) setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleSelectSession(id: string) {
    if (loading) return;
    setActiveSessionId(id);
    setEditingSessionId(null);
    setInput("");
    if (isMobile) setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleTogglePin(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s))
    );
  }

  function handleDeleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (sessions.length <= 1) {
      const resetSess = createNewSession(1);
      setSessions([resetSess]);
      setActiveSessionId(resetSess.id);
      return;
    }

    const updated = sessions.filter((s) => s.id !== id);
    setSessions(updated);
    if (activeSessionId === id) {
      setActiveSessionId(updated[0].id);
    }
  }

  function startRename(s: RobinChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingSessionId(s.id);
    setEditTitleInput(s.title);
  }

  function saveRename(id: string) {
    if (!editTitleInput.trim()) {
      setEditingSessionId(null);
      return;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: editTitleInput.trim() } : s))
    );
    setEditingSessionId(null);
  }

  function addUserMessageToActive(userText: string) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        let autoTitle = s.title;
        if (s.title.startsWith("Session ") && s.messages.length === 1) {
          autoTitle = userText.length > 26 ? userText.slice(0, 26) + "…" : userText;
        }
        return {
          ...s,
          title: autoTitle,
          messages: [...s.messages, { role: "user" as const, content: userText }],
          updated_at: new Date().toISOString(),
        };
      })
    );
  }

  function addAssistantMessageToActive(reply: string, action?: RobinAction) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          messages: [
            ...s.messages,
            { role: "assistant" as const, content: reply, action },
          ],
          updated_at: new Date().toISOString(),
        };
      })
    );
  }

  function markActionConfirmed(idx: number) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          messages: s.messages.map((m, i) =>
            i === idx && m.action ? { ...m, action: { ...m.action, confirmed: true } } : m
          ),
          updated_at: new Date().toISOString(),
        };
      })
    );
  }

  async function processStreamResponse(res: Response) {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let finalReply: string | null = null;
    let finalAction: RobinAction | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line.trim());
          if (event.type === "status" && event.message) {
            setLiveStatus(event.message);
          } else if (event.type === "result") {
            finalReply = event.reply;
            finalAction = event.action ?? null;
          } else if (event.type === "error") {
            finalReply = event.reply || "Something went wrong.";
          }
        } catch {
          // Ignore chunk JSON parse errors
        }
      }
    }

    if (finalReply !== null) {
      addAssistantMessageToActive(finalReply!, finalAction ?? undefined);
    }
  }

  async function send(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || isSendingRef.current || loading) return;

    isSendingRef.current = true;
    addUserMessageToActive(msg);
    setInput("");
    setLoading(true);
    setLiveStatus("🔍 Initiating request…");

    const historyForApi = [...messages, { role: "user" as const, content: msg }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);

    try {
      const res = await fetch("/api/robin/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, history: historyForApi }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) throw new Error("Server error");
      await processStreamResponse(res);
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      addAssistantMessageToActive(
        isAbort
          ? "Robin took too long to respond. Please try sending your message again."
          : "Robin is unavailable right now. Please try again in a moment."
      );
    } finally {
      setLoading(false);
      isSendingRef.current = false;
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function confirmAction(action: RobinAction, idx: number) {
    if (loading) return;
    setLoading(true);
    setLiveStatus(`⚡ Executing in workspace: ${action.description}…`);
    markActionConfirmed(idx);

    try {
      const res = await fetch("/api/robin/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Confirmed: ${action.description}`,
          history: messages,
          confirmAction: true,
          actionToExecute: action,
        }),
      });

      await processStreamResponse(res);
    } catch {
      addAssistantMessageToActive("Something went wrong executing that action.");
    } finally {
      setLoading(false);
    }
  }

  const pinnedSessions = sessions.filter((s) => s.pinned);
  const recentSessions = sessions.filter((s) => !s.pinned);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>
      <Navbar userName={session?.user?.name} />

      {/* Main Container: Sidebar + Chat Area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Mobile Backdrop Overlay */}
        {isMobile && sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              top: 56,
              background: "rgba(0,0,0,0.65)",
              backdropFilter: "blur(3px)",
              zIndex: 40,
            }}
          />
        )}

        {/* Left Sidebar (Desktop: Flex column, Mobile: Slide-over drawer) */}
        <div
          style={{
            position: isMobile ? "fixed" : "relative",
            top: isMobile ? 56 : 0,
            bottom: isMobile ? 0 : "auto",
            left: 0,
            zIndex: isMobile ? 50 : 1,
            height: isMobile ? "calc(100vh - 56px)" : "100%",
            width: sidebarOpen ? 270 : 0,
            transition: "width 0.22s cubic-bezier(0.4, 0, 0.2, 1), transform 0.22s ease",
            transform: isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
            background: "var(--bg-card)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            flexShrink: 0,
            boxShadow: isMobile && sidebarOpen ? "0 12px 32px rgba(0,0,0,0.7)" : "none",
          }}
        >
          {/* Top: New Chat Button + Mobile Close */}
          <div style={{ padding: "12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1, padding: "9px 12px", fontSize: 13, borderRadius: 8, justifyContent: "center" }}
              onClick={handleNewChat}
            >
              + New Chat
            </button>
            {isMobile && (
              <button
                className="btn btn-ghost"
                style={{ padding: "7px 10px", fontSize: 13 }}
                onClick={() => setSidebarOpen(false)}
              >
                ✕
              </button>
            )}
          </div>

          {/* Sessions List */}
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Pinned Section */}
            {pinnedSessions.length > 0 && (
              <div>
                <div className="section-label" style={{ padding: "3px 8px 6px", fontSize: 10 }}>
                  📌 Pinned ({pinnedSessions.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {pinnedSessions.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      isActive={s.id === activeSessionId}
                      isEditing={editingSessionId === s.id}
                      editInput={editTitleInput}
                      onEditChange={setEditTitleInput}
                      onSelect={() => handleSelectSession(s.id)}
                      onTogglePin={(e) => handleTogglePin(s.id, e)}
                      onStartRename={(e) => startRename(s, e)}
                      onSaveRename={() => saveRename(s.id)}
                      onCancelRename={() => setEditingSessionId(null)}
                      onDelete={(e) => handleDeleteSession(s.id, e)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Chats Section */}
            <div>
              <div className="section-label" style={{ padding: "3px 8px 6px", fontSize: 10 }}>
                Chats ({sessions.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {recentSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={s.id === activeSessionId}
                    isEditing={editingSessionId === s.id}
                    editInput={editTitleInput}
                    onEditChange={setEditTitleInput}
                    onSelect={() => handleSelectSession(s.id)}
                    onTogglePin={(e) => handleTogglePin(s.id, e)}
                    onStartRename={(e) => startRename(s, e)}
                    onSaveRename={() => saveRename(s.id)}
                    onCancelRename={() => setEditingSessionId(null)}
                    onDelete={(e) => handleDeleteSession(s.id, e)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Bottom user status */}
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Robin AI</span>
            <span style={{ fontSize: 11, background: "var(--bg-hover)", padding: "2px 8px", borderRadius: 12 }}>
              {sessions.length} {sessions.length === 1 ? "Session" : "Sessions"}
            </span>
          </div>
        </div>

        {/* Right Main Chat Area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg)", overflow: "hidden", minWidth: 0 }}>
          {/* Chat Header */}
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--bg)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <button
                className="btn btn-ghost"
                style={{ padding: "6px 9px", fontSize: 12, borderRadius: 6, flexShrink: 0 }}
                onClick={() => setSidebarOpen(!sidebarOpen)}
                title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              >
                {sidebarOpen ? "◀" : "▶"}
              </button>
              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <h1 style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.3px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span>{activeSession.title}</span>
                  {activeSession.pinned && <span style={{ fontSize: 11 }}>📌</span>}
                </h1>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {pendingClarificationCount > 0 && (
                <Link
                  href="/dashboard"
                  title="Robin has pending questions — go to Workspace to answer them"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    background: "rgba(242,109,33,0.15)",
                    color: "var(--accent)",
                    border: "1px solid rgba(242,109,33,0.35)",
                    padding: "4px 10px",
                    borderRadius: 20,
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    flexShrink: 0,
                    animation: "pulse 2s infinite",
                  }}
                >
                  ❓ {pendingClarificationCount} question{pendingClarificationCount !== 1 ? "s" : ""}
                </Link>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "5px 10px", flexShrink: 0 }}
                onClick={handleNewChat}
              >
                + New
              </button>
            </div>
          </div>

          {/* Message Thread */}
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column" }}>
            <div style={{ maxWidth: 800, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
              {messages.map((msg, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", width: "100%" }}>
                  {msg.role === "user" ? (
                    /* User Message: Right Aligned Orange Bubble */
                    <div style={{ display: "flex", justifyContent: "flex-end", width: "100%", marginBottom: 2 }}>
                      <div
                        style={{
                          maxWidth: isMobile ? "88%" : "75%",
                          padding: "10px 16px",
                          borderRadius: "16px 16px 4px 16px",
                          background: "var(--accent)",
                          color: "#ffffff",
                          fontSize: 13.5,
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          boxShadow: "0 2px 8px rgba(242,109,33,0.25)",
                        }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    /* Assistant Message: Left Aligned with Avatar */
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%", marginBottom: 2 }}>
                      <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--accent)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
                        R
                      </div>
                      <div
                        style={{
                          maxWidth: isMobile ? "88%" : "85%",
                          padding: "12px 16px",
                          borderRadius: "16px 16px 16px 4px",
                          background: "var(--bg-card)",
                          border: "1px solid var(--border)",
                          color: "var(--text-primary)",
                        }}
                      >
                        <div className="markdown-content" style={{ fontSize: 13.5 }}>
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Proposed Action Card */}
                  {msg.action && !msg.action.confirmed && msg.role === "assistant" && (
                    <div style={{ marginLeft: isMobile ? 40 : 44, marginTop: 8, maxWidth: isMobile ? "88%" : "85%" }}>
                      <div style={{ background: "var(--bg-card)", border: "1.5px solid var(--accent)", borderRadius: 12, padding: "14px 16px" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
                          ⚡ Proposed Action
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8, lineHeight: 1.4 }}>
                          {msg.action.description}
                        </div>
                        <div style={{ fontSize: 11, fontFamily: "monospace", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", marginBottom: 12, color: "var(--text-secondary)", overflowX: "auto" }}>
                          {msg.action.type} · {Object.entries(msg.action.params).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <button
                            className="btn btn-primary"
                            style={{ fontSize: 12, padding: "7px 14px" }}
                            onClick={() => confirmAction(msg.action!, i)}
                            disabled={loading}
                          >
                            ✓ Confirm & Execute
                          </button>
                          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            Updates workspace
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Real-time Streaming Shimmer Thought Card */}
              {loading && (
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
                  <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, color: "#fff", flexShrink: 0, boxShadow: "0 0 10px rgba(242,109,33,0.4)" }}>
                    R
                  </div>
                  <div className="shimmer-box" style={{ padding: "12px 16px", maxWidth: "85%", width: 340 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <div className="live-dot" style={{ width: 6, height: 6 }} />
                      <span className="shimmer-text" style={{ fontSize: 12 }}>
                        {liveStatus}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="shimmer-line" style={{ width: "90%" }} />
                      <div className="shimmer-line" style={{ width: "65%" }} />
                    </div>
                  </div>
                </div>
              )}

              {/* Suggested Prompts on New Sessions */}
              {messages.length === 1 && !loading && (
                <div style={{ marginLeft: isMobile ? 0 : 40, display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {PROMPTS.map((p) => (
                    <button
                      key={p}
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: "7px 12px", borderRadius: 20 }}
                      onClick={() => send(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          {/* Bottom Input Bar */}
          <div style={{ padding: isMobile ? "10px 12px 14px" : "14px 16px 18px", borderTop: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0 }} suppressHydrationWarning>
            <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", gap: 8, alignItems: "center" }}>
              <input
                ref={inputRef}
                className="input"
                style={{ flex: 1, fontSize: 13.5, padding: "10px 14px", borderRadius: 8 }}
                placeholder="Ask Robin anything about your work…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
                disabled={loading}
                suppressHydrationWarning
              />
              <button
                className="btn btn-primary"
                style={{ padding: "10px 18px", fontSize: 13.5, flexShrink: 0, borderRadius: 8 }}
                onClick={() => send()}
                disabled={!mounted ? true : Boolean(loading || !input.trim())}
                suppressHydrationWarning
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionItem({
  session,
  isActive,
  isEditing,
  editInput,
  onEditChange,
  onSelect,
  onTogglePin,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onDelete,
}: {
  session: RobinChatSession;
  isActive: boolean;
  isEditing: boolean;
  editInput: string;
  onEditChange: (v: string) => void;
  onSelect: () => void;
  onTogglePin: (e: React.MouseEvent) => void;
  onStartRename: (e: React.MouseEvent) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  if (isEditing) {
    return (
      <div
        style={{
          padding: "5px 6px",
          background: "var(--bg-hover)",
          borderRadius: 6,
          border: "1px solid var(--accent)",
          display: "flex",
          gap: 4,
          alignItems: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="input"
          style={{ padding: "3px 6px", fontSize: 12, height: 26, flex: 1 }}
          value={editInput}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSaveRename();
            if (e.key === "Escape") onCancelRename();
          }}
          autoFocus
        />
        <button
          onClick={onSaveRename}
          style={{ background: "none", border: "none", color: "var(--success)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}
          title="Save"
        >
          ✓
        </button>
        <button
          onClick={onCancelRename}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}
          title="Cancel"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        background: isActive ? "var(--bg-hover)" : "transparent",
        border: isActive ? "1px solid var(--border)" : "1px solid transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        transition: "all 0.15s",
        userSelect: "none",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, color: isActive ? "var(--accent)" : "var(--text-secondary)", flexShrink: 0 }}>
          💬
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: isActive ? 600 : 400,
            color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.title}
        </span>
      </div>

      {/* Action Icons */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button
          onClick={onTogglePin}
          style={{
            background: "none",
            border: "none",
            color: session.pinned ? "var(--accent)" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 3px",
            borderRadius: 3,
            opacity: session.pinned || isActive ? 1 : 0.6,
          }}
          title={session.pinned ? "Unpin session" : "Pin session to top"}
        >
          📌
        </button>
        <button
          onClick={onStartRename}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 3px",
            borderRadius: 3,
            opacity: isActive ? 1 : 0.6,
          }}
          title="Rename session"
        >
          ✏️
        </button>
        <button
          onClick={onDelete}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 3px",
            borderRadius: 3,
            opacity: isActive ? 1 : 0.6,
          }}
          title="Delete session"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}
