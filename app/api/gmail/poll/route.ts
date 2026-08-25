import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchNewEmailsSince, getLatestHistoryId, getEmailById } from "@/lib/gmail";
import { extractTaskFromEmail } from "@/lib/gemini";
import { NextRequest, NextResponse } from "next/server";
import { Task } from "@/types";

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

  const { data: existingTasks } = await supabaseAdmin
    .from("tasks")
    .select("*")
    .eq("user_id", userId);

  const tasks: Task[] = existingTasks ?? [];
  const newEmails = [];

  for (const messageId of newMessageIds) {
    const { data: alreadyStored } = await supabaseAdmin
      .from("emails")
      .select("id")
      .eq("gmail_message_id", messageId)
      .eq("user_id", userId)
      .single();

    if (alreadyStored) continue;

    const emailData = await getEmailById(userId, messageId);

    const { data: threadTask } = await supabaseAdmin
      .from("tasks")
      .select("*")
      .eq("user_id", userId)
      .eq("gmail_thread_id", emailData.thread_id)
      .maybeSingle();

    const extracted = await extractTaskFromEmail(
      emailData.subject,
      emailData.body_snippet,
      tasks,
      threadTask ?? undefined
    );

    let extractedTaskId: string | null = null;

    if (extracted.has_task) {
      const matchedId = extracted.matched_task_id ?? threadTask?.id ?? null;

      if ((extracted.is_update_to_existing || threadTask) && matchedId) {
        const updatePayload: Record<string, string | null> = {
          updated_at: new Date().toISOString(),
        };
        if (extracted.deadline) updatePayload.deadline = extracted.deadline;
        if (extracted.priority) updatePayload.priority = extracted.priority;

        await supabaseAdmin
          .from("tasks")
          .update(updatePayload)
          .eq("id", matchedId)
          .eq("user_id", userId);

        extractedTaskId = matchedId;
      } else {
        const { data: newTask } = await supabaseAdmin
          .from("tasks")
          .insert({
            user_id: userId,
            title: extracted.task_title!,
            priority: extracted.priority ?? "medium",
            deadline: extracted.deadline ?? null,
            status: "todo",
            source: "gmail",
            gmail_thread_id: emailData.thread_id,
            description: extracted.context_summary,
            goal_id: null,
          })
          .select()
          .single();

        if (newTask) {
          extractedTaskId = newTask.id;
          tasks.push(newTask);
        }
      }
    }

    await supabaseAdmin.from("emails").insert({
      user_id: userId,
      ...emailData,
      processed: extracted.has_task,
      extracted_task_id: extractedTaskId,
    });

    newEmails.push({ email: emailData, extracted });
  }

  return NextResponse.json({ historyId: latestHistoryId, newEmails });
}
