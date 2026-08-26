import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchNewEmailsSince, getLatestHistoryId, getEmailById, getThreadMessages } from "@/lib/gmail";
import { analyzeInboundEmail } from "@/lib/gemini";
import { NextRequest, NextResponse } from "next/server";
import { Task, Goal, Clarification } from "@/types";

// Confidence threshold: below this we flag needs_review rather than silently acting
const NEEDS_REVIEW_THRESHOLD = 0.75;

// Max concurrent Gemini calls: 3 parallel × 2 passes × 8s = ~16s worst case for 10 emails
// Sequential was 10 × 16s = 160s. Parallel batch of 3 = ceil(10/3) × 16s ≈ 48-64s.
const PARALLEL_BATCH_SIZE = 3;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const historyId = searchParams.get("historyId");

  if (!historyId) {
    const newHistoryId = await getLatestHistoryId(userId);
    return NextResponse.json({ historyId: newHistoryId, newEmails: [] });
  }

  const newMessageIds = await fetchNewEmailsSince(userId, historyId);
  const latestHistoryId = await getLatestHistoryId(userId);

  if (newMessageIds.length === 0) {
    return NextResponse.json({ historyId: latestHistoryId, newEmails: [] });
  }

  // Load all tasks + goals + existing clarifications once — reused across all emails
  const [tasksRes, goalsRes, clarifRes] = await Promise.all([
    supabaseAdmin.from("tasks").select("*").eq("user_id", userId),
    supabaseAdmin.from("goals").select("*").eq("user_id", userId),
    supabaseAdmin
      .from("clarifications")
      .select("thread_id")
      .eq("user_id", userId)
      .eq("status", "pending"),
  ]);

  // Shared mutable state — written to by each processed email so subsequent
  // emails in the same batch see freshly created tasks (dedup within a single poll)
  const tasks: Task[] = tasksRes.data ?? [];
  const goals: Goal[] = goalsRes.data ?? [];

  // #3 Clarification dedup: track which thread_ids already have a pending question
  // so subsequent emails on the same thread don't generate a second clarification row.
  const pendingClarificationThreadIds = new Set<string>(
    (clarifRes.data ?? []).map((c) => c.thread_id).filter(Boolean)
  );

  // Batch-check which message IDs are already stored to avoid re-processing
  const { data: storedEmails } = await supabaseAdmin
    .from("emails")
    .select("gmail_message_id")
    .eq("user_id", userId)
    .in("gmail_message_id", newMessageIds);
  const storedSet = new Set((storedEmails ?? []).map((e) => e.gmail_message_id));
  const unseenMessageIds = newMessageIds.filter((id) => !storedSet.has(id));

  if (unseenMessageIds.length === 0) {
    return NextResponse.json({ historyId: latestHistoryId, newEmails: [] });
  }

  const newEmails: unknown[] = [];

  // ── Process emails in parallel batches (#1) ────────────────────────────────
  // We cap at PARALLEL_BATCH_SIZE concurrent calls to avoid overwhelming the
  // Gemini quota and Gmail API rate limits while still being dramatically faster
  // than the old sequential loop.
  //
  // NOTE: tasks[] is shared mutable state. Within a batch, tasks created by
  // one email may not be visible to another in the same batch (race condition).
  // This is acceptable — within a single poll, the probability of two emails
  // in the same batch referring to each other is very low. Cross-poll dedup
  // is handled by the DB select at the start of each poll.
  for (let i = 0; i < unseenMessageIds.length; i += PARALLEL_BATCH_SIZE) {
    const batch = unseenMessageIds.slice(i, i + PARALLEL_BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map((messageId) =>
        processOneEmail({
          messageId,
          userId,
          tasks,
          goals,
          pendingClarificationThreadIds,
        })
      )
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        newEmails.push(result.value);
        // If this email created a new task, add it to the shared list so
        // subsequent batches can see it for dedup purposes
        if (result.value.newTask) {
          tasks.push(result.value.newTask);
        }
      } else if (result.status === "rejected") {
        console.error("[Poll] Email processing failed in batch:", result.reason);
      }
    }
  }

  return NextResponse.json({ historyId: latestHistoryId, newEmails });
}

// ── Process a single email ───────────────────────────────────────────────────
async function processOneEmail({
  messageId,
  userId,
  tasks,
  goals,
  pendingClarificationThreadIds,
}: {
  messageId: string;
  userId: string;
  tasks: Task[];
  goals: Goal[];
  pendingClarificationThreadIds: Set<string>;
}): Promise<{ email: unknown; analysis: unknown; newTask?: Task } | null> {
  // Fetch email metadata + full thread in parallel
  const emailData = await getEmailById(userId, messageId);
  const [threadMessages, openClarifData] = await Promise.all([
    getThreadMessages(userId, emailData.thread_id),
    supabaseAdmin
      .from("clarifications")
      .select("*")
      .eq("user_id", userId)
      .eq("thread_id", emailData.thread_id)
      .eq("status", "pending"),
  ]);

  const openClarifications: Clarification[] = openClarifData.data ?? [];

  // ── Core analysis ──────────────────────────────────────────────────────────
  const analysis = await analyzeInboundEmail({
    threadMessages,
    existingTasks: tasks,
    goals,
    openClarifications,
  });

  console.log(
    `[Poll] ${emailData.subject} → classification=${analysis.classification} confidence=${analysis.confidence} goal_id=${analysis.inferred_goal_id ?? "none"}`
  );

  let extractedTaskId: string | null = null;
  let emailProcessed = false;
  let newTask: Task | undefined;

  switch (analysis.classification) {
    // ── No action needed ────────────────────────────────────────────────────
    case "no_action":
    case "fyi_only": {
      emailProcessed = false;
      break;
    }

    // ── New task ─────────────────────────────────────────────────────────────
    case "new_task": {
      if (!analysis.task_title) break;

      const needsReview = analysis.confidence < NEEDS_REVIEW_THRESHOLD;
      const { data: created } = await supabaseAdmin
        .from("tasks")
        .insert({
          user_id: userId,
          title: analysis.task_title,
          description: analysis.description ?? analysis.reasoning,
          priority: analysis.priority ?? "medium",
          deadline: analysis.deadline ?? null,
          status: "todo",
          source: "gmail",
          gmail_thread_id: emailData.thread_id,
          extraction_confidence: analysis.confidence,
          needs_review: needsReview,
          // #2: use deterministically inferred goal_id — never null just because the LLM didn't output one
          goal_id: analysis.inferred_goal_id ?? null,
        })
        .select()
        .single();

      if (created) {
        extractedTaskId = created.id;
        newTask = created as Task;
        await writeDependencies(created.id, analysis.depends_on_task_ids, userId);
      }

      emailProcessed = true;
      break;
    }

    // ── Update existing task ─────────────────────────────────────────────────
    case "task_update": {
      // matched_task_id is already guaranteed to be in existingTasks (guardrail #5 in gemini.ts)
      const targetId = analysis.matched_task_id ?? analysis.duplicate_of_task_id;
      if (!targetId) {
        // matched_task_id was stripped by guardrail — fall through to clarification
        await createClarificationIfNeeded({
          userId,
          emailData,
          analysis: {
            ...analysis,
            clarifying_question:
              analysis.clarifying_question ??
              `I think this email updates an existing task but couldn't confirm which one. Which task does "${emailData.subject}" relate to?`,
          },
          pendingClarificationThreadIds,
        });
        break;
      }

      const updatePayload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (analysis.deadline) updatePayload.deadline = analysis.deadline;
      if (analysis.priority) updatePayload.priority = analysis.priority;
      if (analysis.status_change) updatePayload.status = analysis.status_change;
      if (analysis.description) {
        const existing = tasks.find((t) => t.id === targetId);
        if (existing?.description && analysis.description !== existing.description) {
          updatePayload.description = existing.description + "\n\n[Update] " + analysis.description;
        } else if (!existing?.description) {
          updatePayload.description = analysis.description;
        }
      }
      // #2: update goal_id if we inferred one and the task doesn't already have one
      if (analysis.inferred_goal_id) {
        const existing = tasks.find((t) => t.id === targetId);
        if (!existing?.goal_id) {
          updatePayload.goal_id = analysis.inferred_goal_id;
        }
      }
      if (analysis.confidence < NEEDS_REVIEW_THRESHOLD) {
        updatePayload.needs_review = true;
        updatePayload.extraction_confidence = analysis.confidence;
      }

      await supabaseAdmin
        .from("tasks")
        .update(updatePayload)
        .eq("id", targetId)
        .eq("user_id", userId);

      extractedTaskId = targetId;
      emailProcessed = true;
      await writeDependencies(targetId, analysis.depends_on_task_ids, userId);
      break;
    }

    // ── Needs clarification ──────────────────────────────────────────────────
    case "needs_clarification": {
      await createClarificationIfNeeded({
        userId,
        emailData,
        analysis,
        pendingClarificationThreadIds,
      });
      emailProcessed = false;
      break;
    }
  }

  // Store the email row (always)
  await supabaseAdmin.from("emails").insert({
    user_id: userId,
    ...emailData,
    thread_context: threadMessages,
    processed: emailProcessed,
    extracted_task_id: extractedTaskId,
  });

  return { email: emailData, analysis, newTask };
}

// ── Helper: write task dependencies ─────────────────────────────────────────
async function writeDependencies(
  taskId: string,
  dependsOnIds: string[],
  userId: string
) {
  if (!dependsOnIds || dependsOnIds.length === 0) return;

  const { data: validTasks } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("user_id", userId)
    .in("id", dependsOnIds);

  const validIds = (validTasks ?? []).map((t) => t.id);
  if (validIds.length === 0) return;

  await supabaseAdmin
    .from("task_dependencies")
    .upsert(
      validIds.map((dependsOnId) => ({ task_id: taskId, depends_on_task_id: dependsOnId })),
      { onConflict: "task_id,depends_on_task_id" }
    );
}

// ── Helper: create clarification — with dedup guard (#3) ────────────────────
// Only creates a new clarification row if there isn't already a pending one
// for this thread_id. This prevents three replies to the same ambiguous thread
// from generating three separate "Robin Inbox" cards.
async function createClarificationIfNeeded({
  userId,
  emailData,
  analysis,
  pendingClarificationThreadIds,
}: {
  userId: string;
  emailData: {
    thread_id: string;
    subject: string;
    body_snippet: string;
    from_email: string;
  };
  analysis: {
    clarifying_question?: string | null;
    reasoning?: string;
    matched_task_id?: string | null;
    task_title?: string | null;
    confidence?: number;
    inferred_goal_id?: string | null;
  };
  pendingClarificationThreadIds: Set<string>;
}) {
  // #3: Dedup — skip if a pending clarification already exists for this thread
  if (pendingClarificationThreadIds.has(emailData.thread_id)) {
    console.log(
      `[Poll] Skipping clarification for thread ${emailData.thread_id} — pending one already exists`
    );
    return;
  }

  const question =
    analysis.clarifying_question ??
    `I received an email about "${emailData.subject}" but I'm not sure what action to take. What should I do with this?`;

  const context = {
    draft_extraction: {
      task_title: analysis.task_title,
      confidence: analysis.confidence,
    },
    thread_snippet: emailData.body_snippet.slice(0, 300),
    reasoning: analysis.reasoning,
  };

  const { data: clarification } = await supabaseAdmin
    .from("clarifications")
    .insert({
      user_id: userId,
      thread_id: emailData.thread_id,
      question,
      context,
      status: "pending",
    })
    .select()
    .single();

  // Mark this thread as having a pending clarification so other emails in this
  // same poll batch don't create a second row
  pendingClarificationThreadIds.add(emailData.thread_id);

  const senderName = emailData.from_email.split("<")[0].trim() || emailData.from_email;
  await supabaseAdmin.from("robin_messages").insert({
    user_id: userId,
    role: "assistant",
    content: [
      `📧 **New email from ${senderName}** re: "${emailData.subject}"`,
      ``,
      `> ${emailData.body_snippet.slice(0, 200).replace(/\n/g, " ")}`,
      ``,
      `❓ **${question}**`,
      ``,
      `Reply here or go to **Workspace → Robin Inbox** to answer.`,
    ].join("\n"),
    action: clarification
      ? { type: "clarification", clarification_id: clarification.id }
      : null,
  });
}
