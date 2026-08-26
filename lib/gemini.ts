import { GoogleGenerativeAI } from "@google/generative-ai";
import { EmailAnalysis, RobinContext, RobinAction, Task, Goal, ThreadMessage, Clarification } from "@/types";
import fs from "fs";
import path from "path";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const REQUEST_TIMEOUT_MS = 8000; // Raised from 4000 — two-pass extraction can take longer

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

// ── Degraded-mode fallback (Gemini fully down) ───────────────────────────────
// When the AI is unavailable, we NEVER silently create/skip tasks — we always
// create a clarification row instead, which is safer than making irreversible
// guesses.
function degradedModeAnalysis(): EmailAnalysis {
  return {
    classification: "needs_clarification",
    confidence: 0,
    reasoning: "Gemini API unavailable — degraded mode, deferring to human review",
    task_title: null,
    description: null,
    deadline: null,
    priority: null,
    status_change: null,
    matched_task_id: null,
    duplicate_of_task_id: null,
    depends_on_task_ids: [],
    clarifying_question:
      "Robin couldn't analyze this email (AI temporarily unavailable). " +
      "Is this something that needs action? If so, what should be done?",
  };
}

// ── Pass 1: Full contextual classification ───────────────────────────────────
async function classifyEmail(
  threadMessages: ThreadMessage[],
  existingTasks: Task[],
  goals: Goal[],
  openClarifications: Clarification[]
): Promise<EmailAnalysis> {
  const today = new Date().toISOString().split("T")[0];

  // Build the thread transcript (oldest→newest)
  const threadSection = threadMessages
    .map(
      (m, i) =>
        `[Message ${i + 1}] From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n${m.body.slice(0, 600)}`
    )
    .join("\n\n---\n\n");

  // All open tasks (not done, not cancelled) — no slice cap at this stage
  const openTasks = existingTasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled"
  );
  const taskList = openTasks
    .map(
      (t) =>
        `- ID: ${t.id} | Title: "${t.title}" | Priority: ${t.priority} | Status: ${t.status} | Deadline: ${t.deadline ?? "none"} | ThreadId: ${t.gmail_thread_id ?? "none"}`
    )
    .join("\n") || "None";

  const goalsList = goals
    .map((g) => `- ID: ${g.id} | Title: "${g.title}" | Kind: ${g.kind ?? "goal"}`)
    .join("\n") || "None";

  // Surface any open clarifications for this same thread so we can recognize
  // a reply to a clarifying question
  const pendingClarifications = openClarifications
    .filter((c) => c.status === "pending")
    .map(
      (c) =>
        `- Clarification ID: ${c.id} | Question asked: "${c.question}" | Thread: ${c.thread_id ?? "unknown"}`
    )
    .join("\n") || "None";

  const systemInstruction = `You are Robin's email analysis engine inside WorkBudi.
Today is ${today}. Convert ALL relative dates (\"by Friday\", \"end of next week\", \"tomorrow\") to absolute YYYY-MM-DD.

## Your job
Read the full email thread and return a single JSON object matching the EmailAnalysis schema below.
You MUST base your decision on the entire thread, not just the last message.

## Classification rules (apply in order)
1. "no_action" — automated notifications, receipts, newsletters, tracking emails, calendar invites with no ask, out-of-office replies, CC-only informational forwards where no work is expected.
2. "fyi_only" — a human wrote this, it contains information, but no work is requested. E.g. "Heads up, the meeting moved." "Thanks, got it!" "Just wanted to let you know."
3. "needs_clarification" — set this INSTEAD OF guessing when ANY of these are true:
   - The email references "the project", "that thing we discussed", "the proposal" etc. with 2 or more plausible task matches in the existing task list
   - It's genuinely unclear whether this is new work or an update to an existing task and confidence would be < 0.65
   - A deadline or priority is implied but too vague to act on ("soon", "when you get a chance", "ASAP" without context)
   - The email is a reply in a thread where you previously created a clarification (check pendingClarifications)
4. "task_update" — prefer this over "new_task" when the email plausibly continues an existing task's topic AND you have ≥ 0.65 confidence in the match. Use matched_task_id to point to the exact task. Recognized update signals: deadline change, status change ("done", "drop this", "never mind"), priority escalation, same-thread reply.
5. "new_task" — only when this is genuinely new work unrelated to any existing task AND you are confident enough to act (confidence ≥ 0.65). NEVER fabricate a matched_task_id that isn't in the provided task list.

## Dependency detection
Look for language like "once X ships", "after the contract is signed", "blocked on legal", "when design approves". When found, set depends_on_task_ids to the IDs of the matching tasks from the task list.

## Output schema (return ONLY raw JSON, no markdown fences, no commentary)
{
  "classification": "no_action" | "fyi_only" | "new_task" | "task_update" | "needs_clarification",
  "confidence": 0.0-1.0,
  "reasoning": "brief internal trail — what signals drove your decision",
  "task_title": string | null,
  "description": string | null,
  "deadline": "YYYY-MM-DD" | null,
  "priority": "high" | "medium" | "low" | null,
  "status_change": "todo" | "in-progress" | "done" | "cancelled" | null,
  "matched_task_id": string | null,
  "duplicate_of_task_id": string | null,
  "depends_on_task_ids": [],
  "clarifying_question": string | null
}`;

  const prompt = `=== FULL EMAIL THREAD ===
${threadSection}

=== OPEN TASKS IN WORKSPACE ===
${taskList}

=== GOALS / PROJECTS ===
${goalsList}

=== PENDING CLARIFICATIONS (same threads) ===
${pendingClarifications}`;

  const text = await generateWithFallback(prompt, systemInstruction);
  const clean = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(clean) as EmailAnalysis;
}

// ── Pass 2: Narrow dedup confirmation ────────────────────────────────────────
// Only called when Pass 1 returns "new_task". A cheap yes/no check to make
// sure we're not creating a duplicate. More reliable than trusting a single
// LLM call under time pressure.
async function confirmNotDuplicate(
  candidateTitle: string,
  candidateDescription: string | null,
  openTasks: Task[]
): Promise<{ isDuplicate: boolean; duplicateOfId: string | null }> {
  if (openTasks.length === 0) return { isDuplicate: false, duplicateOfId: null };

  const taskList = openTasks
    .map((t) => `- ID: ${t.id} | Title: "${t.title}"`)
    .join("\n");

  const systemInstruction = `You are a deduplication guard for a task management system.
Your only job: determine if the candidate work item is substantially the same piece of work as any task in the provided list.
"Substantially the same" means the same underlying deliverable — even if the subject line, sender, or phrasing differs.
Respond ONLY with raw JSON: {"is_duplicate": true|false, "duplicate_of_id": "uuid"|null}`;

  const prompt = `Candidate task:
Title: "${candidateTitle}"
Description: "${candidateDescription ?? "(none)"}"

Existing open tasks:
${taskList}`;

  try {
    const text = await generateWithFallback(prompt, systemInstruction);
    const clean = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const result = JSON.parse(clean) as { is_duplicate: boolean; duplicate_of_id: string | null };
    return {
      isDuplicate: result.is_duplicate,
      duplicateOfId: result.duplicate_of_id,
    };
  } catch {
    // If dedup check fails, be conservative: allow the new task through
    return { isDuplicate: false, duplicateOfId: null };
  }
}

// ── Public API: analyzeInboundEmail ──────────────────────────────────────────
/**
 * Analyzes an inbound email using its full thread context plus all open tasks,
 * goals, and any open clarifications for the same thread.
 *
 * Two-pass approach:
 *   Pass 1 — full contextual classification
 *   Pass 2 — narrow dedup confirmation (only when Pass 1 → "new_task")
 *
 * Post-pass guardrails (deterministic, no LLM trust required):
 *   - matched_task_id is validated against the actual task list (#5)
 *   - goal_id is inferred by keyword overlap with goal titles (#2)
 *
 * When Gemini is fully down, returns needs_clarification (degraded mode).
 */
export async function analyzeInboundEmail(params: {
  threadMessages: ThreadMessage[];
  existingTasks: Task[];
  goals: Goal[];
  openClarifications: Clarification[];
}): Promise<EmailAnalysis & { inferred_goal_id?: string | null }> {
  const { threadMessages, existingTasks, goals, openClarifications } = params;

  try {
    // Pass 1: Full classification
    const analysis = await classifyEmail(
      threadMessages,
      existingTasks,
      goals,
      openClarifications
    );

    // Pass 2: Dedup guard — only runs when Pass 1 thinks this is new work
    if (analysis.classification === "new_task" && analysis.task_title) {
      const openTasks = existingTasks.filter(
        (t) => t.status !== "done" && t.status !== "cancelled"
      );
      const { isDuplicate, duplicateOfId } = await confirmNotDuplicate(
        analysis.task_title,
        analysis.description,
        openTasks
      );

      if (isDuplicate && duplicateOfId) {
        // Promote to task_update rather than creating a duplicate
        analysis.classification = "task_update";
        analysis.matched_task_id = duplicateOfId;
        analysis.duplicate_of_task_id = duplicateOfId;
        analysis.reasoning += ` [Dedup pass: matched to existing task ${duplicateOfId}]`;
      }
    }

    // ── Guardrail #5: matched_task_id code-level enforcement ─────────────────
    // The LLM can hallucinate IDs that aren't in the task list we sent.
    // If matched_task_id isn't in existingTasks, force needs_clarification
    // rather than silently updating or ignoring a phantom task.
    if (
      analysis.matched_task_id &&
      !existingTasks.find((t) => t.id === analysis.matched_task_id)
    ) {
      console.warn(
        `[Gemini] matched_task_id ${analysis.matched_task_id} not in task list — forcing needs_clarification`
      );
      analysis.classification = "needs_clarification";
      analysis.matched_task_id = null;
      analysis.clarifying_question =
        analysis.clarifying_question ??
        `I couldn't confidently match this email to an existing task. Which task does "${
          analysis.task_title ?? "this email"
        }" relate to, or is it new work?`;
      analysis.reasoning += " [Guardrail: matched_task_id not in provided task list]";
    }

    // ── Guardrail #2: goal_id inference (deterministic keyword overlap) ───────
    // The LLM doesn't output a goal_id, so we infer one here by checking
    // whether the task title/description keywords overlap with any goal title.
    // This is a best-effort heuristic — no goal linked is better than a wrong one.
    let inferred_goal_id: string | null = null;
    const searchText = [
      analysis.task_title ?? "",
      analysis.description ?? "",
      // Also check the thread subject line (first message is oldest)
      threadMessages[threadMessages.length - 1]?.subject ?? "",
    ]
      .join(" ")
      .toLowerCase();

    if (searchText.trim() && goals.length > 0) {
      // Score each goal by how many of its title words appear in searchText
      const scored = goals
        .filter((g) => g.title.trim().length > 2)
        .map((g) => {
          const goalWords = g.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          const matches = goalWords.filter((w) => searchText.includes(w)).length;
          return { id: g.id, matches };
        })
        .filter((s) => s.matches > 0)
        .sort((a, b) => b.matches - a.matches);

      if (scored.length > 0) {
        inferred_goal_id = scored[0].id;
      }
    }

    return { ...analysis, inferred_goal_id };
  } catch (err) {
    console.error("[Gemini] analyzeInboundEmail failed \u2014 entering degraded mode:", err);
    return { ...degradedModeAnalysis(), inferred_goal_id: null };
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
    const activeTasks = context.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
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

  // General prioritization (dependency-aware)
  const activeTasks = context.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const unblockedTasks = activeTasks.filter((t) => !t.blocked);
  const blockedTasks = activeTasks.filter((t) => t.blocked);
  const highPriority = unblockedTasks.filter((t) => t.priority === "high");
  const mediumPriority = unblockedTasks.filter((t) => t.priority === "medium");

  if (activeTasks.length === 0) {
    return {
      reply: `You have no active tasks right now! 🎉\n\nHead to **Workspace** to add goals and tasks, or click **Fetch Emails** to let Robin extract tasks from your Gmail inbox.`,
      action: null,
    };
  }

  const topTask = highPriority[0] || mediumPriority[0] || unblockedTasks[0] || activeTasks[0];
  const linkedGoal = context.goals.find((g) => g.id === topTask.goal_id);

  let reply = `Here is what I recommend focusing on right now:\n\n`;
  reply += `🎯 **${topTask.title}** (${topTask.priority.toUpperCase()} priority)\n`;
  if (topTask.deadline) reply += `📅 **Deadline:** ${topTask.deadline}\n`;
  if (linkedGoal) reply += `🏆 **Goal:** ${linkedGoal.title}\n`;

  reply += `\n**Why:** `;
  reply +=
    topTask.priority === "high"
      ? `This is your most urgent unblocked item right now.`
      : `This is next in your priority queue.`;

  // Surface blocked tasks as context (not as recommendations)
  if (blockedTasks.length > 0) {
    reply += `\n\n**⛔ Blocked (waiting on dependencies):**\n`;
    reply += blockedTasks
      .slice(0, 3)
      .map((t) => `• ${t.title} — blocked by: ${(t.blocking_task_titles ?? []).join(", ")}`)
      .join("\n");
  }

  if (unblockedTasks.length > 1) {
    const rest = unblockedTasks.filter((t) => t.id !== topTask.id).slice(0, 3);
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
    .map((g) => `- [${g.id}] ${g.title}${g.description ? `: ${g.description}` : ""} [${g.kind ?? "goal"}]`)
    .join("\n") || "None";

  const tasksSection = context.tasks
    .slice(0, 20)
    .map(
      (t) => {
        const blockedNote = t.blocked
          ? ` | BLOCKED by: ${(t.blocking_task_titles ?? []).join(", ")}`
          : "";
        const reviewNote = t.needs_review ? " | ⚠ needs-review" : "";
        return `- [${t.id}] ${t.title} | priority: ${t.priority} | status: ${t.status} | deadline: ${t.deadline ?? "none"}${blockedNote}${reviewNote}`;
      }
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

=== USER GOALS / PROJECTS ===
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
