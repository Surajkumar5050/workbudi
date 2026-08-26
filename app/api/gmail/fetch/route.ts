import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchEmails, getThreadMessages } from "@/lib/gmail";
import { analyzeInboundEmail } from "@/lib/gemini";
import { Task, Goal } from "@/types";

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

        // Load current workspace context
        const [tasksRes, goalsRes] = await Promise.all([
          supabaseAdmin.from("tasks").select("*").eq("user_id", userId),
          supabaseAdmin.from("goals").select("*").eq("user_id", userId),
        ]);
        const tasks: Task[] = tasksRes.data ?? [];
        const goals: Goal[] = goalsRes.data ?? [];

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

          // Fetch full thread context
          const threadMessages = await getThreadMessages(userId, email.thread_id);

          const analysis = await analyzeInboundEmail({
            threadMessages,
            existingTasks: tasks,
            goals,
            openClarifications: [],
          });

          let extractedTaskId: string | null = null;

          switch (analysis.classification) {
            case "no_action":
            case "fyi_only":
              break;

            case "new_task": {
              if (analysis.task_title) {
                const { data: newTask } = await supabaseAdmin
                  .from("tasks")
                  .insert({
                    user_id: userId,
                    title: analysis.task_title,
                    description: analysis.description ?? email.subject,
                    priority: analysis.priority ?? "medium",
                    deadline: analysis.deadline ?? null,
                    status: "todo",
                    source: "gmail",
                    gmail_thread_id: email.thread_id,
                    extraction_confidence: analysis.confidence,
                    needs_review: analysis.confidence < 0.75,
                    waiting_on: analysis.waiting_on ?? null,
                    goal_id: analysis.inferred_goal_id ?? null,
                  })
                  .select()
                  .single();

                if (newTask) {
                  extractedTaskId = newTask.id;
                  tasks.push(newTask);
                  tasksCreatedCount++;
                }
              }
              break;
            }

            case "task_update": {
              const targetId = analysis.matched_task_id;
              if (targetId) {
                const updatePayload: Record<string, unknown> = {
                  updated_at: new Date().toISOString(),
                };
                if (analysis.deadline) updatePayload.deadline = analysis.deadline;
                if (analysis.priority) updatePayload.priority = analysis.priority;
                if (analysis.status_change) updatePayload.status = analysis.status_change;

                await supabaseAdmin
                  .from("tasks")
                  .update(updatePayload)
                  .eq("id", targetId)
                  .eq("user_id", userId);

                extractedTaskId = targetId;
              }
              break;
            }

            case "needs_clarification": {
              // In the manual fetch flow, insert a clarification + Robin message
              const question =
                analysis.clarifying_question ??
                `I received an email about "${email.subject}" but I'm not sure what action to take. What should I do?`;

              // Resolve candidate_task_ids → [{id, title}], silently dropping any ID not found in tasks
              const resolvedCandidates: { id: string; title: string }[] = (
                (analysis.candidate_task_ids ?? []) as string[]
              )
                .slice(0, 4)
                .map((cid: string) => tasks.find((t) => t.id === cid))
                .filter((t): t is Task => t !== undefined)
                .map((t) => ({ id: t.id, title: t.title }));

              await supabaseAdmin.from("clarifications").insert({
                user_id: userId,
                thread_id: email.thread_id,
                question,
                context: {
                  candidate_tasks: resolvedCandidates,
                  thread_snippet: email.body_snippet.slice(0, 300),
                  reasoning: analysis.reasoning,
                },
                status: "pending",
              });

              const senderName = email.from_email.split("<")[0].trim() || email.from_email;
              await supabaseAdmin.from("robin_messages").insert({
                user_id: userId,
                role: "assistant",
                content: `📧 **Email from ${senderName}** re: "${email.subject}"\n\n❓ **${question}**\n\nGo to **Workspace → Robin Inbox** to answer.`,
              });
              break;
            }
          }

          await supabaseAdmin.from("emails").insert({
            user_id: userId,
            ...email,
            thread_context: threadMessages,
            processed: ["new_task", "task_update"].includes(analysis.classification),
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
        const errMsg =
          err instanceof Error && err.message.includes("Google account not linked")
            ? "Your Google session is out of sync. Please click 'Sign out' and sign back in to reconnect Gmail."
            : "Failed while fetching from Gmail. Please try again.";

        sendEvent({
          type: "error",
          message: errMsg,
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
