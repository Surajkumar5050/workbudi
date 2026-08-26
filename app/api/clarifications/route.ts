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
  // Track whether we produced a clean, deliberate outcome that is safe to close.
  // A clarification should NEVER be silently marked "answered" unless:
  //   (a) a task was actually created or updated, OR
  //   (b) the user's answer confirmed there is nothing to do (no_action / fyi_only)
  let safeToClose = false;

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
            needs_review: false,
            goal_id: null,
          })
          .select()
          .single();

        if (newTask) {
          resultingTaskId = newTask.id;
          safeToClose = true;

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
        } else {
          // Task insert returned nothing (rare DB error) — re-ask rather than silently close
          await supabaseAdmin
            .from("clarifications")
            .update({
              question:
                "We had trouble saving your task. Could you rephrase what needs to be done and by when?",
              answer: null,
            })
            .eq("id", id);

          return NextResponse.json({
            status: "still_unclear",
            follow_up_question:
              "We had trouble saving your task. Could you rephrase what needs to be done and by when?",
          });
        }
      } else {
        // AI returned new_task but with no title — the answer wasn't specific enough.
        // Re-ask with a sharper, targeted question instead of silently closing.
        const sharpQuestion =
          reanalysis.clarifying_question ??
          "Your answer didn't make it clear what specific task to create. " +
          "Could you state the exact deliverable and deadline (if any) in one sentence?";

        await supabaseAdmin
          .from("clarifications")
          .update({ question: sharpQuestion, answer: null })
          .eq("id", id);

        return NextResponse.json({
          status: "still_unclear",
          follow_up_question: sharpQuestion,
        });
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
        safeToClose = true;
      } else {
        // AI said task_update but couldn't pinpoint which task — re-ask
        const sharpQuestion =
          reanalysis.clarifying_question ??
          "Which existing task does this update relate to? Please name it specifically.";

        await supabaseAdmin
          .from("clarifications")
          .update({ question: sharpQuestion, answer: null })
          .eq("id", id);

        return NextResponse.json({
          status: "still_unclear",
          follow_up_question: sharpQuestion,
        });
      }
      break;
    }

    case "no_action":
    case "fyi_only": {
      // User explicitly confirmed there is nothing to do — safe to close
      safeToClose = true;
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
      // Still ambiguous after user input — update question and re-present.
      // Also refresh candidate_tasks so the next card round still has tappable options.
      const freshCandidates: { id: string; title: string }[] = (
        reanalysis.candidate_task_ids ?? []
      )
        .slice(0, 4)
        .map((cid) => tasks.find((t) => t.id === cid))
        .filter((t): t is Task => t !== undefined)
        .map((t) => ({ id: t.id, title: t.title }));

      // Merge with existing context, only overwriting candidate_tasks and question
      const updatedContext = {
        ...(clarif.context ?? {}),
        candidate_tasks: freshCandidates,
      };

      await supabaseAdmin
        .from("clarifications")
        .update({
          question: reanalysis.clarifying_question ?? clarif.question,
          answer: null,
          context: updatedContext,
        })
        .eq("id", id);

      return NextResponse.json({
        status: "still_unclear",
        follow_up_question: reanalysis.clarifying_question,
      });
    }


    default: {
      // Unexpected or malformed AI result — never silently close.
      // Surface a follow-up question so work is not lost.
      const fallbackQuestion =
        "Robin couldn't interpret your answer confidently. " +
        "Could you describe the exact task (or confirm there's nothing to do)?";

      await supabaseAdmin
        .from("clarifications")
        .update({ question: fallbackQuestion, answer: null })
        .eq("id", id);

      return NextResponse.json({
        status: "still_unclear",
        follow_up_question: fallbackQuestion,
      });
    }
  }

  // Final guard: only close the clarification if we produced a definitive outcome.
  // This is the structural fix for the silent-close bug — even if somehow the
  // switch falls through without setting safeToClose, we never mark "answered".
  if (!safeToClose) {
    const fallbackQuestion =
      reanalysis.clarifying_question ??
      "We couldn't create or update a task from your answer. " +
      "What specifically needs to be done, and by when?";

    await supabaseAdmin
      .from("clarifications")
      .update({ question: fallbackQuestion, answer: null })
      .eq("id", id);

    return NextResponse.json({
      status: "still_unclear",
      follow_up_question: fallbackQuestion,
    });
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
