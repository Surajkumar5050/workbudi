import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { chatWithRobin } from "@/lib/gemini";
import { executeRobinAction } from "@/lib/tools";
import { NextRequest } from "next/server";
import { RobinMessage, RobinAction } from "@/types";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = session.user.id;
  const body = await req.json();
  const { message, history = [], confirmAction, actionToExecute } = body as {
    message: string;
    history: RobinMessage[];
    confirmAction?: boolean;
    actionToExecute?: RobinAction;
  };

  // Create real-time streaming response using ReadableStream
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendEvent = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        // Direct Action Confirmation Execution
        if (confirmAction) {
          sendEvent({ type: "status", message: "⚡ Executing action in workspace..." });

          let targetAction: RobinAction | null = actionToExecute ?? null;
          if (!targetAction && history.length > 0) {
            for (let i = history.length - 1; i >= 0; i--) {
              if (history[i].action) {
                targetAction = history[i].action!;
                break;
              }
            }
          }

          if (targetAction) {
            const result = await executeRobinAction(targetAction, userId);
            const replyMsg = result.success
              ? `✓ **Done!** ${result.message}`
              : `⚠ **Action Failed:** ${result.message}`;

            try {
              await supabaseAdmin.from("robin_messages").insert([
                { user_id: userId, role: "user", content: `Confirmed: ${targetAction.description}` },
                { user_id: userId, role: "assistant", content: replyMsg },
              ]);
            } catch {
              // Ignore if table not created
            }

            sendEvent({
              type: "result",
              reply: replyMsg,
              action: null,
              executed: result.success,
            });
            controller.close();
            return;
          }
        }

        // Real-time Phase 1: Querying Supabase Database
        sendEvent({ type: "status", message: "🔍 Querying workspace goals & active tasks..." });
        const [goalsRes, tasksRes] = await Promise.all([
          supabaseAdmin.from("goals").select("*").eq("user_id", userId),
          supabaseAdmin
            .from("tasks")
            .select("*")
            .eq("user_id", userId)
            .order("created_at", { ascending: false }),
        ]);

        const goals = goalsRes.data ?? [];
        const tasks = tasksRes.data ?? [];

        // Real-time Phase 2: Querying Gmail Context
        sendEvent({
          type: "status",
          message: `📧 Loading Gmail context (${tasks.length} tasks, ${goals.length} goals found)...`,
        });

        const emailsRes = await supabaseAdmin
          .from("emails")
          .select("*")
          .eq("user_id", userId)
          .order("received_at", { ascending: false })
          .limit(10);

        const recentEmails = emailsRes.data ?? [];

        // Real-time Phase 3: Gemini AI Reasoning
        sendEvent({
          type: "status",
          message: `🧠 Gemini AI is analyzing priorities across ${tasks.length} tasks & ${recentEmails.length} emails…`,
        });

        const context = {
          goals,
          tasks,
          recentEmails,
        };

        const conversationHistory = history.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const { reply, action } = await chatWithRobin(message, context, conversationHistory);

        // Save conversation turn to Supabase if table exists
        try {
          await supabaseAdmin.from("robin_messages").insert([
            { user_id: userId, role: "user", content: message },
            { user_id: userId, role: "assistant", content: reply, action },
          ]);
        } catch {
          // Ignore if table not created
        }

        // Real-time Phase 4: Sending Final Response
        sendEvent({
          type: "result",
          reply,
          action,
        });

        controller.close();
      } catch (err: unknown) {
        console.error("Stream error in Robin chat:", err);
        sendEvent({
          type: "error",
          reply: "Robin encountered an issue processing your request. Please try again.",
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
