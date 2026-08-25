import { supabaseAdmin } from "./supabase";
import { RobinAction, Priority, TaskStatus } from "@/types";

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
      const goal_id = action.params.goal_id || null;

      const { error } = await supabaseAdmin.from("tasks").insert({
        user_id: userId,
        title,
        priority,
        deadline,
        goal_id,
        status: "todo",
        source: "manual",
        description: null,
        gmail_thread_id: null,
      });

      return error
        ? { success: false, message: error.message }
        : { success: true, message: `Created task "${title}"` };
    }

    default:
      return { success: false, message: `Unknown action type "${action.type}"` };
  }
}
