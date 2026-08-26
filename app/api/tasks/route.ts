import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";
import { Priority, TaskStatus } from "@/types";
import { computeBlockedStatus } from "@/lib/tools";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Attach blocked status so dashboard task cards can render the ⛔ badge
  const tasksWithBlocked = await computeBlockedStatus(data ?? [], userId);
  return NextResponse.json(tasksWithBlocked);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { title, description, priority, deadline, goal_id } = body;

  if (!title?.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });

  const validPriorities: Priority[] = ["high", "medium", "low"];
  if (priority && !validPriorities.includes(priority)) {
    return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .insert({
      user_id: session.user.id,
      title: title.trim(),
      description: description?.trim() || null,
      priority: priority ?? "medium",
      deadline: deadline?.trim() ? deadline.trim() : null,
      goal_id: goal_id?.trim() ? goal_id.trim() : null,
      status: "todo",
      source: "manual",
      gmail_thread_id: null,
      needs_review: false,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const allowed = ["title", "description", "priority", "status", "deadline", "goal_id", "needs_review"];
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in updates) {
      let val = updates[key];
      if ((key === "goal_id" || key === "deadline" || key === "description") && typeof val === "string" && !val.trim()) {
        val = null;
      }
      filtered[key] = val;
    }
  }

  const validStatuses: TaskStatus[] = ["todo", "in-progress", "done", "cancelled"];
  const validPriorities: Priority[] = ["high", "medium", "low"];

  if (filtered.status && !validStatuses.includes(filtered.status as TaskStatus)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (filtered.priority && !validPriorities.includes(filtered.priority as Priority)) {
    return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
  }

  filtered.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("tasks")
    .update(filtered)
    .eq("id", id)
    .eq("user_id", session.user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", session.user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
