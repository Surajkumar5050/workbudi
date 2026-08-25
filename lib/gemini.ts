import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractedTaskData, RobinContext, RobinAction, Task } from "@/types";
import fs from "fs";
import path from "path";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const REQUEST_TIMEOUT_MS = 4000;

// ── Load Robin's system prompt from the dedicated .md file ──────────────────
const ROBIN_SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), "lib", "prompts", "robin_system_prompt.md"),
  "utf-8"
);

async function generateWithFallback(
  userPrompt: string,
  systemInstruction?: string
): Promise<string> {
  let lastError: unknown = null;

  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction ?? undefined,
      });

      const result = await Promise.race([
        model.generateContent(userPrompt),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout: ${modelName} took > ${REQUEST_TIMEOUT_MS}ms`)),
            REQUEST_TIMEOUT_MS
          )
        ),
      ]);

      const text = result.response.text().trim();
      if (text) return text;
    } catch (err: unknown) {
      console.warn(`[Gemini] ${modelName} failed:`, err instanceof Error ? err.message : err);
      lastError = err;
      continue;
    }
  }

  throw lastError ?? new Error("All Gemini models unavailable");
}

// ── Email task extraction ────────────────────────────────────────────────────
export async function extractTaskFromEmail(
  emailSubject: string,
  emailBody: string,
  existingTasks: Task[],
  threadTask?: Task
): Promise<ExtractedTaskData> {
  const today = new Date().toISOString().split("T")[0];

  const taskList = existingTasks
    .slice(0, 15)
    .map(
      (t) =>
        `- ID: ${t.id} | Title: "${t.title}" | Priority: ${t.priority} | Deadline: ${t.deadline ?? "none"}`
    )
    .join("\n");

  const threadHint = threadTask
    ? `\nIMPORTANT: An existing task from this Gmail thread already exists: ID=${threadTask.id}, Title="${threadTask.title}". This email is an update/reply to it — do NOT create a duplicate.`
    : "";

  const systemInstruction = `You are WorkBudi's work extraction & deduplication engine.
Your job is to read an inbound email and output structured JSON describing actionable work items and changes.
Today is ${today}. Convert all relative deadline references (e.g. "by Friday", "end of next week", "tomorrow") to absolute YYYY-MM-DD dates.

CRITICAL DEDUPLICATION & UPDATE RULES:
1. Compare this email against the provided "Existing Tasks" list.
2. If this email refers to, follows up on, updates, changes the deadline of, or modifies the priority of ANY existing task (even across separate emails with similar subjects or topics like "Proposal", "Pitch Deck", "Bug", etc.), you MUST set:
   - "is_update_to_existing": true
   - "matched_task_id": "<exact ID of the matching task from Existing Tasks>"
   - "deadline": updated deadline if mentioned (or null if unchanged)
   - "priority": updated priority if urgency changed (or null if unchanged)
3. If it is genuinely brand new work unrelated to any existing task, set "is_update_to_existing": false and "matched_task_id": null.
4. Respond ONLY with raw JSON — no markdown code fences, no commentary.

Schema: {"has_task":bool,"task_title":string|null,"deadline":"YYYY-MM-DD"|null,"priority":"high"|"medium"|"low"|null,"is_update_to_existing":bool,"matched_task_id":string|null,"context_summary":string}`;

  const prompt = `${threadHint ? threadHint + "\n" : ""}Email Subject: ${emailSubject}
Email Body: ${emailBody.slice(0, 800)}

Existing Tasks in Workspace:
${taskList || "None"}`;

  try {
    const text = await generateWithFallback(prompt, systemInstruction);
    const clean = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean) as ExtractedTaskData;
  } catch {
    // Keyword-based heuristic fallback
    const subLower = emailSubject.toLowerCase();
    const bodyLower = emailBody.toLowerCase();
    const isUrgent =
      subLower.includes("urgent") || bodyLower.includes("today") || bodyLower.includes("asap");
    const isActionable =
      subLower.includes("proposal") ||
      subLower.includes("review") ||
      subLower.includes("action") ||
      subLower.includes("invoice") ||
      subLower.includes("update") ||
      bodyLower.includes("can you") ||
      bodyLower.includes("please");

    return {
      has_task: isActionable,
      task_title: isActionable ? emailSubject.replace(/^Re:\s*/i, "").trim() : null,
      deadline: null,
      priority: isUrgent ? "high" : "medium",
      is_update_to_existing: !!threadTask,
      matched_task_id: threadTask?.id ?? null,
      context_summary: emailSubject,
    };
  }
}

// ── Local reasoning fallback (zero-latency, no external API needed) ──────────
function localRobinReasoning(
  userMessage: string,
  context: RobinContext
): { reply: string; action: RobinAction | null } {
  const msg = userMessage.toLowerCase();

  // Status update intent
  if (
    msg.includes("in-progress") ||
    msg.includes("inprogress") ||
    msg.includes("ongoing") ||
    msg.includes("working") ||
    msg.includes("start")
  ) {
    const targetTask =
      context.tasks.find((t) => t.priority === "high" && t.status !== "in-progress") ??
      context.tasks.find((t) => t.status !== "in-progress") ??
      context.tasks[0];

    if (targetTask) {
      return {
        reply: `I've prepared the update to move **"${targetTask.title}"** to **in-progress**. Please confirm below to apply it to your workspace.`,
        action: {
          type: "update_task_status",
          params: { task_id: targetTask.id, status: "in-progress" },
          description: `Move "${targetTask.title}" to in-progress`,
        },
      };
    }
  }

  // Reschedule intent
  if (
    msg.includes("reschedule") ||
    msg.includes("change deadline") ||
    msg.includes("tomorrow")
  ) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const targetTask = context.tasks.find((t) => t.status !== "done") ?? context.tasks[0];
    if (targetTask) {
      return {
        reply: `I've prepared the update to move **"${targetTask.title}"** deadline to tomorrow (${tomorrow}). Please confirm below.`,
        action: {
          type: "update_task_deadline",
          params: { task_id: targetTask.id, new_deadline: tomorrow },
          description: `Move "${targetTask.title}" deadline to tomorrow (${tomorrow})`,
        },
      };
    }
  }

  // Create goal intent
  if (msg.includes("create goal") || msg.includes("add goal") || msg.includes("new goal") || msg.includes("set goal")) {
    const titleMatch = userMessage.replace(/^(create|add|new|set)\s+(a\s+)?(goal\s+)?(to\s+|for\s+)?/i, "").trim();
    const goalTitle = titleMatch || "Scale Q3 Revenue";
    return {
      reply: `I've prepared a new workspace goal: **"${goalTitle}"**. Click confirm below to add it to your dashboard.`,
      action: {
        type: "create_goal",
        params: { title: goalTitle, description: "Created via Robin AI" },
        description: `Create goal: "${goalTitle}"`,
      },
    };
  }

  // Delete goal intent
  if (msg.includes("delete goal") || msg.includes("remove goal") || msg.includes("remove it") || msg.includes("delete it")) {
    const latestGoal = context.goals[context.goals.length - 1];
    const goalTitle = latestGoal?.title || "";
    return {
      reply: goalTitle
        ? `I'll remove the goal **"${goalTitle}"** from your workspace. Please confirm below.`
        : `Which goal would you like to remove? I can see: ${context.goals.map((g) => `**${g.title}**`).join(", ")}.`,
      action: goalTitle
        ? {
            type: "delete_goal" as const,
            params: { title: goalTitle },
            description: `Delete goal: "${goalTitle}"`,
          }
        : null,
    };
  }

  // Delete task intent
  if (msg.includes("delete task") || msg.includes("remove task")) {
    const activeTasks = context.tasks.filter((t) => t.status !== "done");
    const targetTask = activeTasks[0] ?? context.tasks[0];
    return {
      reply: targetTask
        ? `I'll delete the task **"${targetTask.title}"** from your workspace. Please confirm below.`
        : `No tasks found to delete.`,
      action: targetTask
        ? {
            type: "delete_task" as const,
            params: { task_id: targetTask.id, title: targetTask.title },
            description: `Delete task: "${targetTask.title}"`,
          }
        : null,
    };
  }

  // Create task intent
  if (msg.includes("create task") || msg.includes("add task") || msg.includes("new task")) {
    const titleMatch = userMessage.replace(/^(create|add|new)\s+(task\s+)?(to\s+)?/i, "").trim();
    const taskTitle = titleMatch || "Review team deliverables";
    return {
      reply: `I've prepared a new task: **"${taskTitle}"** with Medium priority. Click confirm below to add it to your workspace.`,
      action: {
        type: "create_task",
        params: { title: taskTitle, priority: "medium", deadline: "" },
        description: `Create task: "${taskTitle}"`,
      },
    };
  }

  // General prioritization
  const activeTasks = context.tasks.filter((t) => t.status !== "done");
  const highPriority = activeTasks.filter((t) => t.priority === "high");
  const mediumPriority = activeTasks.filter((t) => t.priority === "medium");

  if (activeTasks.length === 0) {
    return {
      reply: `You have no active tasks right now! 🎉\n\nHead to **Workspace** to add goals and tasks, or click **Fetch Emails** to let WorkBudi extract tasks from your Gmail inbox.`,
      action: null,
    };
  }

  const topTask = highPriority[0] || mediumPriority[0] || activeTasks[0];
  const linkedGoal = context.goals.find((g) => g.id === topTask.goal_id);

  let reply = `Here is what I recommend focusing on right now:\n\n`;
  reply += `🎯 **${topTask.title}** (${topTask.priority.toUpperCase()} priority)\n`;
  if (topTask.deadline) reply += `📅 **Deadline:** ${topTask.deadline}\n`;
  if (linkedGoal) reply += `🏆 **Goal:** ${linkedGoal.title}\n`;

  reply += `\n**Why:** `;
  reply +=
    topTask.priority === "high"
      ? `This is your most urgent item right now.`
      : `This is next in your priority queue.`;

  if (activeTasks.length > 1) {
    const rest = activeTasks.filter((t) => t.id !== topTask.id).slice(0, 3);
    reply += `\n\n**Also in queue:**\n` + rest.map((t) => `• ${t.title} (${t.priority})`).join("\n");
  }

  return { reply, action: null };
}

// ── Main Robin chat function ─────────────────────────────────────────────────
export async function chatWithRobin(
  userMessage: string,
  context: RobinContext,
  conversationHistory: Array<{ role: string; content: string }>
): Promise<{ reply: string; action: RobinAction | null }> {
  const today = new Date().toISOString().split("T")[0];

  // Build structured context blocks
  const goalsSection = context.goals
    .map((g) => `- ${g.title}${g.description ? `: ${g.description}` : ""}`)
    .join("\n") || "None";

  const tasksSection = context.tasks
    .slice(0, 12)
    .map(
      (t) =>
        `- [${t.id}] ${t.title} | priority: ${t.priority} | status: ${t.status} | deadline: ${t.deadline ?? "none"}`
    )
    .join("\n") || "None";

  const emailsSection = context.recentEmails
    .slice(0, 6)
    .map(
      (e) =>
        `- From ${e.from_email.split("<")[0].trim()}: "${e.subject}"\n  "${e.body_snippet.slice(0, 130).replace(/\n/g, " ")}"`
    )
    .join("\n") || "None";

  const historySection = conversationHistory
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "Robin"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  // Assemble the user-turn context prompt
  const contextPrompt = `WORKSPACE CONTEXT (Today: ${today})

=== USER GOALS ===
${goalsSection}

=== TASKS IN DATABASE ===
${tasksSection}

=== RECENT INBOUND EMAILS ===
${emailsSection}

${historySection ? `=== CONVERSATION HISTORY ===\n${historySection}\n` : ""}=== USER MESSAGE ===
${userMessage}`;

  try {
    const text = await generateWithFallback(contextPrompt, ROBIN_SYSTEM_PROMPT);

    // Parse optional ACTION block from end of response
    const actionMatch = text.match(/ACTION:(\{[\s\S]*?\})\s*$/);
    let action: RobinAction | null = null;
    let reply = text;

    if (actionMatch) {
      try {
        action = JSON.parse(actionMatch[1]) as RobinAction;
        reply = text.replace(/ACTION:\{[\s\S]*?\}\s*$/, "").trim();
      } catch {
        action = null;
      }
    }

    return { reply, action };
  } catch {
    return localRobinReasoning(userMessage, context);
  }
}
