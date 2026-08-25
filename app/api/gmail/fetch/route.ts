import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchEmails } from "@/lib/gmail";
import { extractTaskFromEmail } from "@/lib/gemini";
import { Task } from "@/types";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = session.user.id;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendEvent = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        sendEvent({
          type: "status",
          step: "connect",
          message: "Connecting to Gmail API & scanning inbox…",
          current: 0,
          total: 0,
        });

        // Fetch up to 12 recent emails from Gmail
        const emails = await fetchEmails(userId, 12);

        if (!emails || emails.length === 0) {
          sendEvent({
            type: "done",
            message: "No emails found in Gmail inbox.",
            current: 0,
            total: 0,
            processedCount: 0,
          });
          controller.close();
          return;
        }

        sendEvent({
          type: "status",
          step: "check_existing",
          message: `Found ${emails.length} emails. Checking workspace database…`,
          current: 0,
          total: emails.length,
        });

        // Batch check which emails are already stored
        const messageIds = emails.map((e) => e.gmail_message_id);
        const { data: storedEmails } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("user_id", userId)
          .in("gmail_message_id", messageIds);

        const storedSet = new Set(storedEmails?.map((e) => e.gmail_message_id) || []);
        const newEmails = emails.filter((e) => !storedSet.has(e.gmail_message_id));

        if (newEmails.length === 0) {
          sendEvent({
            type: "done",
            message: `All ${emails.length} emails are already up to date!`,
            current: emails.length,
            total: emails.length,
            processedCount: 0,
          });
          controller.close();
          return;
        }

        // Get existing tasks for deduplication context
        const { data: existingTasks } = await supabaseAdmin
          .from("tasks")
          .select("*")
          .eq("user_id", userId);

        const tasks: Task[] = existingTasks ?? [];
        let processedCount = 0;
        let tasksCreatedCount = 0;

        for (let i = 0; i < newEmails.length; i++) {
          const email = newEmails[i];
          const shortSubject = email.subject.length > 35 ? email.subject.slice(0, 35) + "…" : email.subject;

          sendEvent({
            type: "progress",
            step: "analyzing",
            message: `Analyzing email ${i + 1} of ${newEmails.length}: "${shortSubject}"`,
            current: i + 1,
            total: newEmails.length,
            subject: email.subject,
          });

          // Check if related task exists from the same thread
          const { data: threadTask } = await supabaseAdmin
            .from("tasks")
            .select("*")
            .eq("user_id", userId)
            .eq("gmail_thread_id", email.thread_id)
            .maybeSingle();

          const extracted = await extractTaskFromEmail(
            email.subject,
            email.body_snippet,
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
                  title: extracted.task_title || email.subject,
                  priority: extracted.priority ?? "medium",
                  deadline: extracted.deadline ?? null,
                  status: "todo",
                  source: "gmail",
                  gmail_thread_id: email.thread_id,
                  description: extracted.context_summary || email.subject,
                  goal_id: null,
                })
                .select()
                .single();

              if (newTask) {
                extractedTaskId = newTask.id;
                tasks.push(newTask);
                tasksCreatedCount++;
              }
            }
          }

          await supabaseAdmin.from("emails").insert({
            user_id: userId,
            ...email,
            processed: extracted.has_task,
            extracted_task_id: extractedTaskId,
          });

          processedCount++;
        }

        sendEvent({
          type: "done",
          step: "complete",
          message: `Complete! Ingested ${processedCount} emails and extracted ${tasksCreatedCount} new tasks.`,
          current: newEmails.length,
          total: newEmails.length,
          processedCount,
          tasksCreatedCount,
        });

        controller.close();
      } catch (err: unknown) {
        console.error("Error in Gmail fetch stream:", err);
        sendEvent({
          type: "error",
          message: "Failed while fetching from Gmail. Please try again.",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
