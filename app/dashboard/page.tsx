"use client";

import { useState, useEffect, useCallback } from "react";
import { Goal, Task, Priority, TaskStatus, Clarification } from "@/types";
import Navbar from "@/components/Navbar";
import { useSession } from "next-auth/react";

type TForm = {
  title: string;
  description: string;
  priority: Priority;
  deadline: string;
  goal_id: string;
  status: TaskStatus;
};
const blank: TForm = {
  title: "",
  description: "",
  priority: "medium",
  deadline: "",
  goal_id: "",
  status: "todo",
};

export default function DashboardPage() {
  const { data: session } = useSession();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clarifications, setClarifications] = useState<Clarification[]>([]);
  const [loading, setLoading] = useState(true);
  const [goalInput, setGoalInput] = useState("");
  const [goalDesc, setGoalDesc] = useState("");
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<TForm>(blank);
  const [editing, setEditing] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [gr, tr, cr] = await Promise.all([
        fetch("/api/goals"),
        fetch("/api/tasks"),
        fetch("/api/clarifications"),
      ]);
      const goalsData = await gr.json();
      const tasksData = await tr.json();
      const clarifData = cr.ok ? await cr.json() : [];
      setGoals(Array.isArray(goalsData) ? goalsData : []);
      setTasks(Array.isArray(tasksData) ? tasksData : []);
      setClarifications(Array.isArray(clarifData) ? clarifData : []);
    } catch {
      setError("Could not load workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function addGoal() {
    if (!goalInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: goalInput, description: goalDesc }),
      });
      if (!res.ok) throw new Error();
      const newGoal = await res.json();
      setGoals((p) => [...p, newGoal]);
      setGoalInput("");
      setGoalDesc("");
      setShowGoalForm(false);
    } catch {
      setError("Could not add goal.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteGoal(id: string) {
    const res = await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
    if (res.ok) setGoals((p) => p.filter((g) => g.id !== id));
    else setError("Could not delete goal.");
  }

  async function saveTask() {
    if (!form.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const res = await fetch("/api/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...form }),
        });
        if (!res.ok) throw new Error();
        const u = await res.json();
        setTasks((p) => p.map((t) => (t.id === u.id ? u : t)));
      } else {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!res.ok) throw new Error();
        const newTask = await res.json();
        setTasks((p) => [newTask, ...p]);
      }
      setShowModal(false);
      setEditing(null);
      setForm(blank);
    } catch {
      setError("Could not save task.");
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(id: string, status: TaskStatus) {
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      const u = await res.json();
      setTasks((p) => p.map((t) => (t.id === u.id ? u : t)));
    } else setError("Could not update status.");
  }

  async function deleteTask(id: string) {
    const res = await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    if (res.ok) setTasks((p) => p.filter((t) => t.id !== id));
    else setError("Could not delete task.");
  }

  function openEdit(task: Task) {
    setEditing(task);
    setForm({
      title: task.title,
      description: task.description ?? "",
      priority: task.priority,
      deadline: task.deadline ?? "",
      goal_id: task.goal_id ?? "",
      status: task.status,
    });
    setShowModal(true);
  }

  async function answerClarification(id: string, answer: string) {
    const res = await fetch("/api/clarifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer }),
    });
    if (res.ok) {
      const result = await res.json();
      if (result.status === "still_unclear") {
        // Re-fetch clarifications so the card stays visible with the new sharper question
        const cr = await fetch("/api/clarifications");
        const clarifData = cr.ok ? await cr.json() : [];
        setClarifications(Array.isArray(clarifData) ? clarifData : []);
      } else {
        setClarifications((prev) => prev.filter((c) => c.id !== id));
      }
      // Refresh tasks in case a new one was created or updated
      const tr = await fetch("/api/tasks");
      const tasksData = await tr.json();
      if (Array.isArray(tasksData)) setTasks(tasksData);
    } else {
      setError("Could not answer clarification.");
    }
  }


  async function dismissClarification(id: string) {
    const res = await fetch("/api/clarifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "", action: "dismiss" }),
    });
    if (res.ok) {
      setClarifications((prev) => prev.filter((c) => c.id !== id));
    } else {
      setError("Could not dismiss clarification.");
    }
  }

  async function acknowledgeReview(id: string) {
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, needs_review: false }),
    });
    if (res.ok) {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, needs_review: false } : t))
      );
    } else {
      setError("Could not acknowledge task.");
    }
  }

  // Kanban columns include "cancelled" for visibility
  const cols: { key: TaskStatus; label: string; dimmed?: boolean }[] = [
    { key: "todo", label: "To Do" },
    { key: "in-progress", label: "In Progress" },
    { key: "done", label: "Done" },
    { key: "cancelled", label: "Cancelled", dimmed: true },
  ];

  return (
    <>
      <Navbar userName={session?.user?.name} />

      <div className="page-wrap">
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 24,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.5px" }}>Workspace</h1>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
              Your goals and tasks — organized.
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setForm(blank);
              setError(null);
              setShowModal(true);
            }}
          >
            + New Task
          </button>
        </div>

        {error && <div className="toast-err" style={{ marginBottom: 16 }}>{error}</div>}

        {/* ── Robin Inbox (Pending Clarifications) ── */}
        {clarifications.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 14,
              }}
            >
              <span className="section-label">❓ Robin Inbox</span>
              <span
                style={{
                  fontSize: 11,
                  background: "rgba(242,109,33,0.15)",
                  color: "var(--accent)",
                  border: "1px solid rgba(242,109,33,0.3)",
                  padding: "1px 7px",
                  borderRadius: 20,
                  fontWeight: 600,
                }}
              >
                {clarifications.length} pending
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                — Robin needs your input to create tasks from these emails
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {clarifications.map((c) => (
                <ClarificationCard
                  key={c.id}
                  clarification={c}
                  onAnswer={(answer) => answerClarification(c.id, answer)}
                  onDismiss={() => dismissClarification(c.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Goals ── */}
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="section-label">Goals</span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  padding: "1px 7px",
                  borderRadius: 20,
                }}
              >
                {goals.length}
              </span>
            </div>
            <button
              className="btn btn-ghost"
              style={{ padding: "5px 12px", fontSize: 12 }}
              onClick={() => setShowGoalForm(!showGoalForm)}
            >
              {showGoalForm ? "Cancel" : "+ Add Goal"}
            </button>
          </div>

          {showGoalForm && (
            <div className="card" style={{ padding: 18, marginBottom: 16 }}>
              <div style={{ marginBottom: 10 }}>
                <input
                  className="input"
                  placeholder="Goal title — what do you want to achieve?"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addGoal()}
                  autoFocus
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  placeholder="Description (optional)"
                  value={goalDesc}
                  onChange={(e) => setGoalDesc(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "6px 14px" }}
                  onClick={() => setShowGoalForm(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 12, padding: "6px 14px" }}
                  onClick={addGoal}
                  disabled={saving || !goalInput.trim()}
                >
                  {saving ? <div className="spinner" /> : "Save Goal"}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
              <div className="spinner-dark" />
            </div>
          ) : goals.length === 0 ? (
            <div
              className="card"
              style={{ padding: "36px 20px", textAlign: "center", borderStyle: "dashed" }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>No goals yet</div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 }}>
                Add goals to give Robin context on what matters most.
              </p>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => setShowGoalForm(true)}
              >
                + Add your first goal
              </button>
            </div>
          ) : (
            <div className="goals-grid">
              {goals.map((g) => {
                const n = tasks.filter((t) => t.goal_id === g.id).length;
                return (
                  <div key={g.id} className="card" style={{ padding: "16px 18px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 8,
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{g.title}</span>
                        {g.kind === "project" && (
                          <span
                            style={{
                              fontSize: 10,
                              background: "var(--bg-hover)",
                              color: "var(--text-secondary)",
                              padding: "1px 6px",
                              borderRadius: 10,
                              fontWeight: 500,
                            }}
                          >
                            project
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => deleteGoal(g.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          fontSize: 13,
                          padding: "0 2px",
                          lineHeight: 1,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
                      >
                        ✕
                      </button>
                    </div>
                    {g.description && (
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          marginBottom: 8,
                          lineHeight: 1.4,
                        }}
                      >
                        {g.description}
                      </p>
                    )}
                    <div
                      style={{
                        borderTop: "1px solid var(--border)",
                        paddingTop: 8,
                        fontSize: 11,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {n} linked {n === 1 ? "task" : "tasks"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Tasks Kanban ── */}
        <section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <span className="section-label">Tasks</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {tasks.length} total
            </span>
          </div>

          <div className="tasks-grid">
            {cols.map((col) => {
              const colTasks = tasks.filter((t) => t.status === col.key);
              return (
                <div
                  key={col.key}
                  style={{
                    background: col.dimmed ? "var(--bg)" : "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 280,
                    opacity: col.dimmed ? 0.75 : 1,
                  }}
                >
                  {/* Col header */}
                  <div
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: col.dimmed ? "var(--text-secondary)" : "var(--text-primary)" }}>
                      {col.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        background: "var(--bg-hover)",
                        padding: "2px 8px",
                        borderRadius: 20,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {colTasks.length}
                    </span>
                  </div>
                  {/* Cards */}
                  <div
                    style={{
                      flex: 1,
                      padding: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        goals={goals}
                        onEdit={openEdit}
                        onDelete={deleteTask}
                        onStatus={updateStatus}
                        onReview={acknowledgeReview}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          border: "1px dashed var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          textAlign: "center",
                          padding: 20,
                          minHeight: 80,
                        }}
                      >
                        No {col.label.toLowerCase()} tasks
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Task Edit/Create Modal */}
      {showModal && (
        <div
          className="overlay"
          onClick={(e) => e.target === e.currentTarget && setShowModal(false)}
        >
          <div className="modal">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 18,
              }}
            >
              <h2 style={{ fontSize: 17, fontWeight: 600 }}>
                {editing ? "Edit Task" : "New Task"}
              </h2>
              <button
                onClick={() => {
                  setShowModal(false);
                  setEditing(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 15,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="field-label">Title *</label>
                <input
                  className="input"
                  placeholder="What needs to be done?"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label">Description</label>
                <textarea
                  className="input"
                  style={{ resize: "vertical", minHeight: 64 }}
                  placeholder="Context, notes..."
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">Priority</label>
                  <select
                    className="select"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">Status</label>
                  <select
                    className="select"
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
                  >
                    <option value="todo">To Do</option>
                    <option value="in-progress">In Progress</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">Deadline</label>
                  <input
                    type="date"
                    className="input"
                    value={form.deadline}
                    onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Goal</label>
                  <select
                    className="select"
                    value={form.goal_id}
                    onChange={(e) => setForm({ ...form, goal_id: e.target.value })}
                  >
                    <option value="">None</option>
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {error && <div className="toast-err" style={{ marginTop: 12 }}>{error}</div>}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 18,
                paddingTop: 14,
                borderTop: "1px solid var(--border)",
              }}
            >
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setShowModal(false);
                  setEditing(null);
                  setForm(blank);
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={saveTask}
                disabled={saving || !form.title.trim()}
              >
                {saving ? <div className="spinner" /> : editing ? "Update Task" : "Create Task"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── ClarificationCard ────────────────────────────────────────────────────────
function ClarificationCard({
  clarification,
  onAnswer,
  onDismiss,
}: {
  clarification: Clarification;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const [freeText, setFreeText] = useState("");
  const [answering, setAnswering] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  const candidateTasks: { id: string; title: string }[] =
    clarification.context?.candidate_tasks ?? [];
  const threadSnippet = clarification.context?.thread_snippet as string | undefined;
  const reasoning = clarification.context?.reasoning as string | undefined;

  async function handleAnswer(answer: string) {
    setAnswering(true);
    await onAnswer(answer);
    setAnswering(false);
  }

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1.5px solid rgba(242,109,33,0.35)",
        borderRadius: 12,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>❓</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            {clarification.question}
          </span>
        </div>
        <button
          onClick={onDismiss}
          title="Dismiss"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            padding: "2px 4px",
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      {/* Email snippet */}
      {threadSnippet && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            lineHeight: 1.5,
            fontStyle: "italic",
          }}
        >
          "{threadSnippet.slice(0, 220)}{threadSnippet.length > 220 ? "…" : ""}"
        </div>
      )}

      {/* Reasoning disclosure toggle */}
      {reasoning && (
        <div>
          <button
            onClick={() => setShowReasoning((v) => !v)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              color: "var(--text-secondary)",
              padding: 0,
              textDecoration: "underline dotted",
            }}
          >
            {showReasoning ? "▾" : "▸"} Why am I being asked this?
          </button>
          {showReasoning && (
            <p
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                marginTop: 5,
                lineHeight: 1.5,
                fontStyle: "italic",
                paddingLeft: 12,
              }}
            >
              {reasoning}
            </p>
          )}
        </div>
      )}

      {/* Quick-pick candidate tasks */}
      {candidateTasks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Possible matches:
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {candidateTasks.slice(0, 4).map((ct) => (
              <button
                key={ct.id}
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: "6px 12px", borderRadius: 20 }}
                disabled={answering}
                onClick={() => handleAnswer(`This updates the task: "${ct.title}" (ID: ${ct.id})`)}
              >
                📋 {ct.title}
              </button>
            ))}
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: "6px 12px", borderRadius: 20 }}
              disabled={answering}
              onClick={() => handleAnswer("This is new work — please create a new task")}
            >
              ✨ New task
            </button>
          </div>
        </div>
      )}

      {/* Free-text answer */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="input"
          style={{ flex: 1, fontSize: 12, padding: "7px 10px" }}
          placeholder="Or type your answer…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && freeText.trim()) {
              handleAnswer(freeText.trim());
              setFreeText("");
            }
          }}
          disabled={answering}
        />
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, padding: "7px 14px", flexShrink: 0 }}
          disabled={answering || !freeText.trim()}
          onClick={() => {
            if (freeText.trim()) {
              handleAnswer(freeText.trim());
              setFreeText("");
            }
          }}
        >
          {answering ? <div className="spinner" style={{ width: 14, height: 14 }} /> : "Answer"}
        </button>
      </div>
    </div>
  );
}

// ── TaskCard ─────────────────────────────────────────────────────────────────
function TaskCard({
  task,
  goals,
  onEdit,
  onDelete,
  onStatus,
  onReview,
}: {
  task: Task;
  goals: Goal[];
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onReview: (id: string) => void;
}) {
  const goal = goals.find((g) => g.id === task.goal_id);
  const isOverdue =
    task.deadline && task.status !== "done" && task.status !== "cancelled" && new Date(task.deadline) < new Date();

  return (
    <div
      style={{
        background: "var(--bg)",
        border: `1px solid ${task.blocked ? "rgba(248,113,113,0.35)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "12px 14px",
        opacity: task.status === "cancelled" ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.4,
            textDecoration: task.status === "cancelled" ? "line-through" : "none",
            color: task.status === "cancelled" ? "var(--text-secondary)" : "var(--text-primary)",
          }}
        >
          {task.title}
        </span>
        <span className={`badge badge-${task.priority}`} style={{ flexShrink: 0, fontSize: 11 }}>
          {task.priority}
        </span>
      </div>

      {task.description && (
        <p
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            marginBottom: 8,
            lineHeight: 1.4,
          }}
        >
          {task.description.slice(0, 90)}
          {task.description.length > 90 ? "…" : ""}
        </p>
      )}

      {/* Badges row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
        {goal && (
          <span
            style={{
              fontSize: 10,
              background: "var(--accent-dim)",
              color: "var(--accent)",
              padding: "2px 8px",
              borderRadius: 20,
              fontWeight: 500,
            }}
          >
            🎯 {goal.title}
          </span>
        )}
        {task.deadline && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 20,
              fontWeight: 500,
              background: isOverdue ? "rgba(248,113,113,0.12)" : "var(--bg-hover)",
              color: isOverdue ? "var(--danger)" : "var(--text-secondary)",
            }}
          >
            {isOverdue ? "⚠ " : "📅 "}
            {task.deadline}
          </span>
        )}
        {task.source === "gmail" && (
          <span
            style={{
              fontSize: 10,
              background: "var(--bg-hover)",
              color: "var(--text-secondary)",
              padding: "2px 8px",
              borderRadius: 20,
            }}
          >
            📧 Gmail
          </span>
        )}
        {/* Blocked badge */}
        {task.blocked && (
          <span
            style={{
              fontSize: 10,
              background: "rgba(248,113,113,0.12)",
              color: "var(--danger)",
              padding: "2px 8px",
              borderRadius: 20,
              fontWeight: 600,
            }}
            title={`Blocked by: ${(task.blocking_task_titles ?? []).join(", ")}`}
          >
            ⛔ Blocked by: {(task.blocking_task_titles ?? []).slice(0, 1).join("")}
            {(task.blocking_task_titles ?? []).length > 1 && ` +${(task.blocking_task_titles ?? []).length - 1}`}
          </span>
        )}
        {/* Waiting-on badge */}
        {task.waiting_on && (
          <span
            style={{
              fontSize: 10,
              background: "rgba(59,130,246,0.10)",
              color: "#2563eb",
              padding: "2px 8px",
              borderRadius: 20,
              fontWeight: 500,
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`Waiting on: ${task.waiting_on}`}
          >
            ⏳ Waiting: {task.waiting_on.length > 32 ? task.waiting_on.slice(0, 32) + "…" : task.waiting_on}
          </span>
        )}
        {/* Needs review badge + one-click Looks right button */}
        {task.needs_review && (
          <>
            <span
              style={{
                fontSize: 10,
                background: "rgba(234,179,8,0.12)",
                color: "#ca8a04",
                padding: "2px 8px",
                borderRadius: 20,
                fontWeight: 500,
              }}
              title="Robin extracted this with low confidence — verify the details"
            >
              ⚠ Review
            </span>
            <button
              className="btn btn-ghost"
              style={{
                fontSize: 10,
                padding: "2px 9px",
                borderRadius: 20,
                color: "#16a34a",
                border: "1px solid rgba(22,163,74,0.35)",
              }}
              title="Confirm this task looks correct"
              onClick={() => onReview(task.id)}
            >
              ✓ Looks right
            </button>
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          paddingTop: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <select
          className="select"
          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
          value={task.status}
          onChange={(e) => onStatus(task.id, e.target.value as TaskStatus)}
        >
          <option value="todo">To Do</option>
          <option value="in-progress">In Progress</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button
          className="btn btn-ghost"
          style={{ padding: "4px 10px", fontSize: 11 }}
          onClick={() => onEdit(task)}
        >
          Edit
        </button>
        <button
          className="btn btn-danger"
          style={{ padding: "4px 8px", fontSize: 11 }}
          onClick={() => onDelete(task.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
