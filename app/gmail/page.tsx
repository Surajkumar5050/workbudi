"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Email } from "@/types";
import Navbar from "@/components/Navbar";
import { useSession } from "next-auth/react";

function stripHtml(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function displayBody(raw: string): string {
  if (!raw) return "";
  if (raw.includes("<") && raw.includes(">")) return stripHtml(raw);
  return raw;
}

export default function GmailPage() {
  const { data: session } = useSession();
  const [emails, setEmails] = useState<Email[]>([]);
  const [selected, setSelected] = useState<Email | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(true);

  // Live Fetch Streaming State
  const [fetching, setFetching] = useState(false);
  const [fetchProgressText, setFetchProgressText] = useState<string>("Connecting to Gmail…");
  const [fetchCurrent, setFetchCurrent] = useState(0);
  const [fetchTotal, setFetchTotal] = useState(0);
  const [fetchSuccessMessage, setFetchSuccessMessage] = useState<string | null>(null);

  const [polling, setPolling] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadEmails = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/list");
      if (!res.ok) throw new Error();
      const list: Email[] = await res.json();
      setEmails(list);
      if (list.length > 0) setSelected((s) => s ?? list[0]);
    } catch {
      setError("Could not load emails.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEmails();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadEmails]);

  async function fetchFromGmail() {
    if (fetching) return;
    setFetching(true);
    setError(null);
    setFetchSuccessMessage(null);
    setFetchProgressText("Connecting to Gmail API & scanning inbox…");
    setFetchCurrent(0);
    setFetchTotal(0);

    try {
      const res = await fetch("/api/gmail/fetch", { method: "POST" });
      if (!res.ok) throw new Error("Fetch request failed");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream body");

      const decoder = new TextDecoder();
      let buffer = "";
      let finalMessage = "";

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
            if (event.message) {
              setFetchProgressText(event.message);
            }
            if (typeof event.current === "number") setFetchCurrent(event.current);
            if (typeof event.total === "number") setFetchTotal(event.total);

            if (event.type === "done") {
              finalMessage = event.message || "Fetch complete!";
            } else if (event.type === "error") {
              throw new Error(event.message || "Fetch error");
            }
          } catch {
            // Ignore partial parse errors
          }
        }
      }

      await loadEmails();
      setFetchSuccessMessage(finalMessage || "Done! Inbox is up to date.");

      const pr = await fetch("/api/gmail/poll");
      if (pr.ok) {
        const pollData = await pr.json();
        setHistoryId(pollData.historyId);
      }

      setTimeout(() => setFetchSuccessMessage(null), 4500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not fetch emails from Gmail.");
    } finally {
      setFetching(false);
      setFetchCurrent(0);
      setFetchTotal(0);
    }
  }

  async function checkNow() {
    if (!historyId) return;
    try {
      const r = await fetch(`/api/gmail/poll?historyId=${historyId}`);
      if (r.ok) {
        const d = await r.json();
        setHistoryId(d.historyId);
        if (d.newEmails?.length) {
          setNewCount((n) => n + d.newEmails.length);
          await loadEmails();
        }
      }
    } catch {
      setError("Poll check failed.");
    }
  }

  function togglePolling() {
    if (polling) {
      if (pollRef.current) clearInterval(pollRef.current);
      setPolling(false);
      setHistoryId(null);
      setNewCount(0);
      return;
    }
    setPolling(true);
    setNewCount(0);
    pollRef.current = setInterval(async () => {
      const hid = historyId;
      if (!hid) {
        const r = await fetch("/api/gmail/poll");
        if (r.ok) setHistoryId((await r.json()).historyId);
        return;
      }
      const r = await fetch(`/api/gmail/poll?historyId=${hid}`);
      if (r.ok) {
        const d = await r.json();
        setHistoryId(d.historyId);
        if (d.newEmails?.length) {
          setNewCount((n) => n + d.newEmails.length);
          await loadEmails();
        }
      }
    }, 30000);
  }

  const senderName = (from: string) =>
    from.split("<")[0].replace(/"/g, "").trim() || from;

  const percent = fetchTotal > 0 ? Math.round((fetchCurrent / fetchTotal) * 100) : 15;

  return (
    <>
      <Navbar userName={session?.user?.name} />
      <div className="page-wrap">
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 20,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.5px" }}>Gmail</h1>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
              Emails are analyzed by Gemini AI to extract tasks and deadlines.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {polling && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  padding: "5px 12px",
                  borderRadius: 24,
                }}
              >
                <div className="live-dot" />
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--success)" }}>
                  Live{newCount > 0 ? ` · ${newCount} new` : ""}
                </span>
                <button
                  onClick={checkNow}
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Check now
                </button>
              </div>
            )}

            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: "7px 12px" }}
              onClick={togglePolling}
            >
              {polling ? "Stop Polling" : "Start Live Polling"}
            </button>

            <button
              className="btn btn-primary"
              style={{ fontSize: 12, padding: "7px 14px" }}
              onClick={fetchFromGmail}
              disabled={fetching}
            >
              {fetching ? (
                <>
                  <div className="spinner" />
                  <span>
                    {fetchTotal > 0 ? `Analyzing (${fetchCurrent}/${fetchTotal})…` : "Fetching…"}
                  </span>
                </>
              ) : (
                "Fetch Emails"
              )}
            </button>
          </div>
        </div>

        {error && <div className="toast-err" style={{ marginBottom: 14 }}>{error}</div>}

        {/* Live Real-Time Fetch Progress Banner */}
        {fetching && (
          <div
            className="shimmer-box"
            style={{
              padding: "14px 18px",
              marginBottom: 16,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="live-dot" style={{ width: 7, height: 7 }} />
                <span className="shimmer-text" style={{ fontSize: 13, fontWeight: 600 }}>
                  {fetchProgressText}
                </span>
              </div>
              {fetchTotal > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>
                  {percent}%
                </span>
              )}
            </div>

            {/* Progress bar track */}
            <div
              style={{
                width: "100%",
                height: 6,
                background: "rgba(255, 255, 255, 0.08)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--accent) 0%, var(--accent-hover) 100%)",
                  borderRadius: 4,
                  transition: "width 0.25s ease",
                }}
              />
            </div>
          </div>
        )}

        {/* Success Banner */}
        {fetchSuccessMessage && !fetching && (
          <div
            style={{
              background: "var(--accent-dim)",
              border: "1px solid var(--accent)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--accent)",
              marginBottom: 16,
              fontWeight: 500,
            }}
          >
            ✓ {fetchSuccessMessage}
          </div>
        )}

        {/* 2-column layout */}
        <div className="gmail-split">
          {/* Left — Email List */}
          <div
            className="card"
            style={{
              display: mobileView === "detail" ? "none" : "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span className="section-label">Inbox</span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {emails.length} emails
              </span>
            </div>

            <div style={{ flex: 1, overflowY: "auto" }}>
              {loading ? (
                <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
                  <div className="spinner-dark" />
                </div>
              ) : emails.length === 0 ? (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: "var(--text-secondary)",
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 6 }}>📭</div>
                  <p>No emails yet.</p>
                  <p style={{ fontSize: 12, marginTop: 4 }}>
                    Click &quot;Fetch Emails&quot; to import from Gmail.
                  </p>
                </div>
              ) : (
                emails.map((email) => {
                  const isSel = selected?.id === email.id;
                  return (
                    <button
                      key={email.id}
                      onClick={() => {
                        setSelected(email);
                        setMobileView("detail");
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "12px 14px",
                        borderBottom: "1px solid var(--border)",
                        background: isSel ? "var(--bg-hover)" : "transparent",
                        borderLeft: isSel ? "3px solid var(--accent)" : "3px solid transparent",
                        cursor: "pointer",
                        display: "block",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 160,
                          }}
                        >
                          {senderName(email.from_email)}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-secondary)", flexShrink: 0 }}>
                          {new Date(email.received_at).toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginBottom: 2,
                        }}
                      >
                        {email.subject}
                      </div>

                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayBody(email.body_snippet).slice(0, 70)}
                      </div>

                      {email.processed && (
                        <div style={{ marginTop: 5 }}>
                          <span
                            style={{
                              fontSize: 10,
                              color: "var(--accent)",
                              background: "var(--accent-dim)",
                              padding: "2px 7px",
                              borderRadius: 20,
                              fontWeight: 500,
                            }}
                          >
                            ✓ Task extracted
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right — Reading Pane */}
          <div
            className="card"
            style={{
              display: mobileView === "list" && typeof window !== "undefined" && window.innerWidth <= 768 ? "none" : "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {selected ? (
              <>
                {/* Mobile Back Button + Email header */}
                <div
                  style={{
                    padding: "16px 20px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg)",
                    flexShrink: 0,
                  }}
                >
                  <button
                    className="btn btn-ghost mobile-only-btn"
                    style={{ fontSize: 12, padding: "4px 8px", marginBottom: 12 }}
                    onClick={() => setMobileView("list")}
                  >
                    ← Back to Inbox
                  </button>

                  <h2 style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, marginBottom: 8 }}>
                    {selected.subject}
                  </h2>
                  <div
                    style={{
                      display: "flex",
                      gap: 16,
                      flexWrap: "wrap",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <span>
                      <strong style={{ color: "var(--text-primary)" }}>From:</strong>{" "}
                      {selected.from_email}
                    </span>
                    <span>
                      <strong style={{ color: "var(--text-primary)" }}>Date:</strong>{" "}
                      {new Date(selected.received_at).toLocaleString()}
                    </span>
                  </div>
                  {selected.processed && (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        background: "var(--accent-dim)",
                        border: "1px solid var(--accent)",
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        color: "var(--accent)",
                        fontWeight: 500,
                      }}
                    >
                      ✓ WorkBudi analyzed this email and updated your workspace tasks
                    </div>
                  )}
                </div>

                {/* Email body */}
                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "20px",
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: "var(--text-primary)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {displayBody(selected.body_snippet)}
                </div>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-secondary)",
                  textAlign: "center",
                  fontSize: 13,
                  padding: 24,
                }}
              >
                <div>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>📩</div>
                  <p>Select an email to read it</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
