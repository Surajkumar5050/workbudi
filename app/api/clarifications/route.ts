import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { analyzeInboundEmail } from "@/lib/gemini";
import { NextRequest, NextResponse } from "next/server";
import { Task, Goal, Clarification, ThreadMessage } from "@/types";

// ── GET /api/clarifications ───────────────────────────────────────────────────
// Returns all pending clarifications for the session user, newest first.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("clarifications")
    .select("*")
    .eq("user_id", session.user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ── PATCH /api/clarifications ─────────────────────────────────────────────────
// Accepts { id, answer } — re-runs analyzeInboundEmail with the user's answer
// appended as context, creates/updates the appropriate task, then resolves the
// clarification row. Also handles "dismiss" to close without creating a task.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body = await req.json() as { id: string; answer: string; action?: "answer" | "dismiss" };
  const { id, answer, action = "answer" } = body;

  if (!id) {
    return NextResponse.json({ error: "Missing clarification id" }, { status: 400 });
  }

  // Fetch the clarification row
  const { data: clarif, error: clarifErr } = await supabaseAdmin
    .from("clarifications")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (clarifErr || !clarif) {
    return NextResponse.json({ error: "Clarification not found" }, { status: 404 });
  }

  if (clarif.status !== "pending") {
    return NextResponse.json({ error: "Clarification already resolved" }, { status: 409 });
  }

  // Dismiss path — mark as dismissed, no task action
  if (action === "dismiss") {
    await supabaseAdmin
      .from("clarifications")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", id);

    // Also mark the email as processed so it doesn't surface again
    if (clarif.email_id) {
      await supabaseAdmin
        .from("emails")
        .update({ processed: true })
        .eq("id", clarif.email_id)
        .eq("user_id", userId);
    }

    return NextResponse.json({ status: "dismissed" });
  }

  if (!answer?.trim()) {
    return NextResponse.json({ error: "Answer is required" }, { status: 400 });
  }

  // Load current workspace context
  const [tasksRes, goalsRes] = await Promise.all([
    supabaseAdmin.from("tasks").select("*").eq("user_id", userId),
    supabaseAdmin.from("goals").select("*").eq("user_id", userId),
  ]);
  const tasks: Task[] = tasksRes.data ?? [];
  const goals: Goal[] = goalsRes.data ?? [];

  // Reconstruct thread messages from the stored email context
  let threadMessages: ThreadMessage[] = [];

  if (clarif.email_id) {
    const { data: emailRow } = await supabaseAdmin
      .from("emails")
      .select("thread_context, body_snippet, subject, from_email, received_at")
      .eq("id", clarif.email_id)
      .single();

    if (emailRow?.thread_context) {
      threadMessages = emailRow.thread_context as ThreadMessage[];
    } else if (emailRow) {
      // Fallback: reconstruct a single-message thread from stored snippet
      threadMessages = [{
        from: emailRow.from_email ?? "",
        date: emailRow.received_at ?? new Date().toISOString(),
        subject: emailRow.subject ?? "",
        body: emailRow.body_snippet ?? "",
      }];
    }
  } else if (clarif.context?.thread_snippet) {
    // Use the snippet stored in clarification context if no email row
    threadMessages = [{
      from: "",
      date: new Date().toISOString(),
      subject: "(email thread)",
      body: clarif.context.thread_snippet as string,
    }];
  }

  // Append the user's clarifying answer as an explicit context message.
  // This lets the LLM know exactly what the user intended.
  const answerMessage: ThreadMessage = {
    from: "User (clarification answer)",
    date: new Date().toISOString(),
    subject: "Re: clarification",
    body: `User clarified: ${answer}`,
  };
  const enrichedThread = [...threadMessages, answerMessage];

  // Re-run the full extraction with the answer included
  const reanalysis = await analyzeInboundEmail({
    threadMessages: enrichedThread,
    existingTasks: tasks,
    goals,
    openClarifications: [], // no open clarifications for re-analysis
  });

  let resultingTaskId: string | null = null;

  switch (reanalysis.classification) {
    case "new_task": {
      if (reanalysis.task_title) {
        const { data: newTask } = await supabaseAdmin
          .from("tasks")
          .insert({
            user_id: userId,
            title: reanalysis.task_title,
            description: reanalysis.description,
            priority: reanalysis.priority ?? "medium",
            deadline: reanalysis.deadline ?? null,
            status: "todo",
            source: "gmail",
            gmail_thread_id: clarif.thread_id,
            extraction_confidence: reanalysis.confidence,
            needs_review: false, // user confirmed — no longer needs review
            goal_id: null,
          })
          .select()
          .single();

        if (newTask) {
          resultingTaskId = newTask.id;

          // Write dependencies if detected
          if (reanalysis.depends_on_task_ids?.length > 0) {
            const validTasks = tasks.filter((t) =>
              reanalysis.depends_on_task_ids.includes(t.id)
            );
            if (validTasks.length > 0) {
              await supabaseAdmin.from("task_dependencies").upsert(
                validTasks.map((vt) => ({
                  task_id: newTask.id,
                  depends_on_task_id: vt.id,
                })),
                { onConflict: "task_id,depends_on_task_id" }
              );
            }
          }
        }
      }
      break;
    }

    case "task_update": {
      const targetId = reanalysis.matched_task_id;
      if (targetId) {
        const updatePayload: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          needs_review: false,
        };
        if (reanalysis.deadline) updatePayload.deadline = reanalysis.deadline;
        if (reanalysis.priority) updatePayload.priority = reanalysis.priority;
        if (reanalysis.status_change) updatePayload.status = reanalysis.status_change;
        if (reanalysis.description) updatePayload.description = reanalysis.description;

        await supabaseAdmin
          .from("tasks")
          .update(updatePayload)
          .eq("id", targetId)
          .eq("user_id", userId);

        resultingTaskId = targetId;
      }
      break;
    }

    case "no_action":
    case "fyi_only": {
      // User clarified that there's nothing to do — mark email processed
      if (clarif.email_id) {
        await supabaseAdmin
          .from("emails")
          .update({ processed: true })
          .eq("id", clarif.email_id)
          .eq("user_id", userId);
      }
      break;
    }

    case "needs_clarification": {
      // Still ambiguous even after user input — update the clarification question
      // rather than resolving it, so the user can try again
      await supabaseAdmin
        .from("clarifications")
        .update({
          question: reanalysis.clarifying_question ?? clarif.question,
          answer: null,
        })
        .eq("id", id);

      return NextResponse.json({
        status: "still_unclear",
        follow_up_question: reanalysis.clarifying_question,
      });
    }
  }

  // Mark clarification as answered
  await supabaseAdmin
    .from("clarifications")
    .update({
      status: "answered",
      answer,
      resulting_task_id: resultingTaskId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Mark original email as processed
  if (clarif.email_id) {
    await supabaseAdmin
      .from("emails")
      .update({ processed: true, extracted_task_id: resultingTaskId })
      .eq("id", clarif.email_id)
      .eq("user_id", userId);
  }

  return NextResponse.json({
    status: "answered",
    resulting_task_id: resultingTaskId,
    classification: reanalysis.classification,
  });
}
