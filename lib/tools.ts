import { supabaseAdmin } from "./supabase";
import { RobinAction, Priority, TaskStatus, Task } from "@/types";

// Narrow shape returned by the Supabase dependency select (only these two columns)
type DepRow = { task_id: string; depends_on_task_id: string };

function normalizeStatus(statusRaw: unknown): TaskStatus | null {
  if (typeof statusRaw !== "string") return null;
  const s = statusRaw.toLowerCase().replace(/_/g, "-").trim();
  if (s === "todo" || s === "to-do" || s === "backlog") return "todo";
  if (
    s === "in-progress" ||
    s === "inprogress" ||
    s === "doing" ||
    s === "active" ||
    s === "ongoing" ||
    s === "wip" ||
    s === "started" ||
    s === "working"
  ) {
    return "in-progress";
  }
  if (s === "done" || s === "completed" || s === "finished" || s === "resolved") return "done";
  if (s === "cancelled" || s === "canceled" || s === "dropped" || s === "closed") return "cancelled";
  return null;
}

function normalizePriority(priorityRaw: unknown): Priority | null {
  if (typeof priorityRaw !== "string") return null;
  const p = priorityRaw.toLowerCase().trim();
  if (p === "high" || p === "urgent" || p === "critical") return "high";
  if (p === "medium" || p === "normal" || p === "standard") return "medium";
  if (p === "low" || p === "minor") return "low";
  return null;
}

async function resolveTaskId(
  rawId: unknown,
  userId: string,
  hintTitle?: string
): Promise<string | null> {
  const { data: allUserTasks } = await supabaseAdmin
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (!allUserTasks || allUserTasks.length === 0) return null;

  const targetStr = typeof rawId === "string" ? rawId.trim() : "";

  // 1. Exact UUID Match
  if (targetStr && targetStr !== "undefined" && targetStr !== "null") {
    const exact = allUserTasks.find((t) => t.id === targetStr);
    if (exact) return exact.id;

    // 2. Prefix Match (e.g. 8-char short ID "6053e74a")
    const prefixMatch = allUserTasks.find(
      (t) => t.id.startsWith(targetStr) || targetStr.startsWith(t.id)
    );
    if (prefixMatch) return prefixMatch.id;

    // 3. Match against task title keywords
    const keywordMatch = allUserTasks.find((t) =>
      t.title.toLowerCase().includes(targetStr.toLowerCase())
    );
    if (keywordMatch) return keywordMatch.id;
  }

  // 4. Match against hint title if passed
  if (hintTitle) {
    const hintMatch = allUserTasks.find((t) =>
      t.title.toLowerCase().includes(hintTitle.toLowerCase())
    );
    if (hintMatch) return hintMatch.id;
  }

  // 5. Smart Fallback: Pick top active high-priority task in 'todo'
  const highPriorityTodo = allUserTasks.find(
    (t) => t.priority === "high" && t.status === "todo"
  );
  if (highPriorityTodo) return highPriorityTodo.id;

  const anyTodo = allUserTasks.find((t) => t.status === "todo");
  if (anyTodo) return anyTodo.id;

  return allUserTasks[0].id;
}

/**
 * Computes blocked status for a list of tasks by joining against task_dependencies.
 * A task is blocked if it has at least one dependency whose depended-on task is
 * not yet in 'done' status. This is deterministic — no LLM involvement.
 *
 * Mutates and returns the same array (adds .blocked and .blocking_task_titles).
 */
export async function computeBlockedStatus(tasks: Task[], userId: string): Promise<Task[]> {
  if (tasks.length === 0) return tasks;

  const taskIds = tasks.map((t) => t.id);

  // Fetch all dependency rows where task_id is in our task set
  const { data: depsRaw } = await supabaseAdmin
    .from("task_dependencies")
    .select("task_id, depends_on_task_id")
    .in("task_id", taskIds);

  const deps: DepRow[] = (depsRaw ?? []) as DepRow[];

  if (deps.length === 0) {
    // No dependencies — nothing is blocked
    return tasks.map((t) => ({ ...t, blocked: false, blocking_task_titles: [] }));
  }

  // Build a quick lookup: taskId → task object
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // For tasks with dependencies, also fetch the blocker tasks if they're not
  // already in our list (e.g. dependency created by a different email session)
  const blockerIds = deps
    .map((d) => d.depends_on_task_id)
    .filter((id) => !taskById.has(id));

  if (blockerIds.length > 0) {
    const { data: blockerTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, title, status")
      .in("id", blockerIds)
      .eq("user_id", userId);
    (blockerTasks ?? []).forEach((bt) => {
      if (!taskById.has(bt.id)) taskById.set(bt.id, bt as Task);
    });
  }

  return tasks.map((task) => {
    const myDeps = deps.filter((d) => d.task_id === task.id);
    if (myDeps.length === 0) {
      return { ...task, blocked: false, blocking_task_titles: [] };
    }

    const blockers = myDeps
      .map((d) => taskById.get(d.depends_on_task_id))
      .filter(
        (blocker): blocker is Task =>
          blocker !== undefined && blocker.status !== "done" && blocker.status !== "cancelled"
      );

    return {
      ...task,
      blocked: blockers.length > 0,
      blocking_task_titles: blockers.map((b) => b.title),
    };
  });
}

async function resolveGoalId(
  rawGoalIdOrName: unknown,
  userId: string,
  hintText?: string
): Promise<string | null> {
  const { data: goals } = await supabaseAdmin
    .from("goals")
    .select("id, title")
    .eq("user_id", userId);

  if (!goals || goals.length === 0) return null;

  const targetStr = typeof rawGoalIdOrName === "string" ? rawGoalIdOrName.trim().toLowerCase() : "";

  if (targetStr && targetStr !== "undefined" && targetStr !== "null") {
    // 1. Exact UUID match
    const exact = goals.find((g) => g.id.toLowerCase() === targetStr);
    if (exact) return exact.id;

    // 2. Exact or substring title match
    const titleMatch = goals.find(
      (g) =>
        g.title.toLowerCase() === targetStr ||
        g.title.toLowerCase().includes(targetStr) ||
        targetStr.includes(g.title.toLowerCase())
    );
    if (titleMatch) return titleMatch.id;
  }

  // 3. Match against hint text if provided (e.g. task title or action description)
  if (hintText) {
    const hintLower = hintText.toLowerCase();
    const hintMatch = goals.find((g) => {
      const words = g.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      return (
        words.some((w: string) => hintLower.includes(w)) ||
        hintLower.includes(g.title.toLowerCase())
      );
    });
    if (hintMatch) return hintMatch.id;
  }

  return null;
}

export async function executeRobinAction(
  action: RobinAction,
  userId: string
): Promise<{ success: boolean; message: string }> {
  const rawTaskId = action.params.task_id || action.params.id || action.params.taskId;
  const hintTitle = action.params.title || action.description;

  switch (action.type) {
    case "update_task_deadline": {
      const resolvedId = await resolveTaskId(rawTaskId, userId, hintTitle);
      const newDeadline = action.params.new_deadline || action.params.deadline;

      if (!resolvedId) {
        return { success: false, message: "Could not find task to reschedule" };
      }
      if (!newDeadline) {
        return { success: false, message: "Missing deadline date" };
      }

      const { data: updated, error } = await supabaseAdmin
        .from("tasks")
        .update({ deadline: newDeadline, updated_at: new Date().toISOString() })
        .eq("id", resolvedId)
        .eq("user_id", userId)
        .select()
        .single();

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Updated "${updated?.title}" deadline to ${newDeadline}` };
    }

    case "update_task_status": {
      const targetStatus =
        normalizeStatus(action.params.status || action.params.new_status) ?? "in-progress";
      const resolvedId = await resolveTaskId(rawTaskId, userId, hintTitle);

      if (!resolvedId) {
        return { success: false, message: "Could not find task to update" };
      }

      const { data: updated, error } = await supabaseAdmin
        .from("tasks")
        .update({ status: targetStatus, updated_at: new Date().toISOString() })
        .eq("id", resolvedId)
        .eq("user_id", userId)
        .select()
        .single();

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Moved "${updated?.title}" to "${targetStatus}"` };
    }

    case "update_task_priority": {
      const targetPriority =
        normalizePriority(action.params.priority || action.params.new_priority) ?? "high";
      const resolvedId = await resolveTaskId(rawTaskId, userId, hintTitle);

      if (!resolvedId) {
        return { success: false, message: "Could not find task to update" };
      }

      const { data: updated, error } = await supabaseAdmin
        .from("tasks")
        .update({ priority: targetPriority, updated_at: new Date().toISOString() })
        .eq("id", resolvedId)
        .eq("user_id", userId)
        .select()
        .single();

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Updated "${updated?.title}" priority to "${targetPriority}"` };
    }

    case "create_task": {
      const title = action.params.title || action.params.task_title || "New follow-up task";
      const priority = normalizePriority(action.params.priority) ?? "medium";
      const deadline = action.params.deadline || null;
      const rawGoal = action.params.goal_id || action.params.goal || action.params.goal_name;
      const resolvedGoalId = await resolveGoalId(rawGoal, userId, `${title} ${action.description}`);

      const { error } = await supabaseAdmin.from("tasks").insert({
        user_id: userId,
        title,
        priority,
        deadline,
        goal_id: resolvedGoalId,
        status: "todo",
        source: "manual",
        description: null,
        gmail_thread_id: null,
        needs_review: false,
      });

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Created task "${title}"` };
    }

    case "create_goal": {
      const title = action.params.title || action.params.goal_title || "New Goal";
      const description = action.params.description || null;

      const { error } = await supabaseAdmin.from("goals").insert({
        user_id: userId,
        title,
        description,
        kind: "goal",
      });

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Created new goal: "${title}"` };
    }

    case "delete_goal": {
      const goalId = action.params.goal_id || action.params.id || null;
      const goalTitle = action.params.title || action.params.goal_title || null;

      let resolvedGoalId: string | null = goalId;

      // Resolve by title if no ID given
      if (!resolvedGoalId && goalTitle) {
        const { data: goals } = await supabaseAdmin
          .from("goals")
          .select("id, title")
          .eq("user_id", userId);
        const match = goals?.find(
          (g) =>
            g.title.toLowerCase().includes(goalTitle.toLowerCase()) ||
            goalTitle.toLowerCase().includes(g.title.toLowerCase())
        );
        resolvedGoalId = match?.id ?? null;
      }

      if (!resolvedGoalId) {
        return { success: false, message: "Could not find a goal to delete" };
      }

      const { error } = await supabaseAdmin
        .from("goals")
        .delete()
        .eq("id", resolvedGoalId)
        .eq("user_id", userId);

      return error
        ? { success: false, message: error.message }
        : { success: true, message: "Goal removed from your workspace" };
    }

    case "delete_task": {
      const rawTaskId = action.params.task_id || action.params.id || null;
      const hintTitle = action.params.task_title || action.params.title || undefined;
      const resolvedId = await resolveTaskId(rawTaskId, userId, hintTitle);

      if (!resolvedId) {
        return { success: false, message: "Could not find task to delete" };
      }

      const { data: deleted, error } = await supabaseAdmin
        .from("tasks")
        .delete()
        .eq("id", resolvedId)
        .eq("user_id", userId)
        .select()
        .single();

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Deleted task "${deleted?.title}"` };
    }

    default:
      return { success: false, message: `Unknown action type "${action.type}"` };
  }
}
