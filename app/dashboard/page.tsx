"use client";

import { useState, useEffect, useCallback } from "react";
import { Goal, Task, Priority, TaskStatus } from "@/types";
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
      const [gr, tr] = await Promise.all([fetch("/api/goals"), fetch("/api/tasks")]);
      setGoals(await gr.json());
      setTasks(await tr.json());
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

  const cols: { key: TaskStatus; label: string }[] = [
    { key: "todo", label: "To Do" },
    { key: "in-progress", label: "In Progress" },
    { key: "done", label: "Done" },
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
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{g.title}</span>
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
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 280,
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
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{col.label}</span>
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

      {/* Modal */}
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

function TaskCard({
  task,
  goals,
  onEdit,
  onDelete,
  onStatus,
}: {
  task: Task;
  goals: Goal[];
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
}) {
  const goal = goals.find((g) => g.id === task.goal_id);
  const isOverdue =
    task.deadline && task.status !== "done" && new Date(task.deadline) < new Date();

  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 14px",
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
        <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{task.title}</span>
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
