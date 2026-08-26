// ── Core value types ──────────────────────────────────────────────────────────
export type Priority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in-progress" | "done" | "cancelled";
export type TaskSource = "manual" | "gmail";
export type GoalKind = "goal" | "project";

// ── EmailAnalysis classification returned by analyzeInboundEmail ─────────────
export type EmailClassification =
  | "no_action"
  | "fyi_only"
  | "new_task"
  | "task_update"
  | "needs_clarification";

// ── Domain models ─────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  kind: GoalKind;
  created_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  goal_id: string | null;
  title: string;
  description: string | null;
  priority: Priority;
  status: TaskStatus;
  deadline: string | null;
  source: TaskSource;
  gmail_thread_id: string | null;
  extraction_confidence: number | null;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
  // Computed at query time — not stored in DB
  blocked?: boolean;
  blocking_task_titles?: string[];
}

export interface TaskDependency {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

/** A single message in an email thread, parsed for LLM consumption. */
export interface ThreadMessage {
  from: string;
  date: string;
  subject: string;
  body: string;
}

export interface Email {
  id: string;
  user_id: string;
  gmail_message_id: string;
  thread_id: string;
  subject: string;
  from_email: string;
  body_snippet: string;
  received_at: string;
  processed: boolean;
  extracted_task_id: string | null;
  /** Full thread context stored at poll time. */
  thread_context: ThreadMessage[] | null;
}

/**
 * Clarification row — created when Robin cannot confidently classify an email.
 * The user resolves it via the Robin Inbox UI; resolution re-runs extraction.
 */
export interface Clarification {
  id: string;
  user_id: string;
  email_id: string | null;
  thread_id: string | null;
  question: string;
  /** Contains candidate_tasks, draft_extraction, thread_snippet, reasoning */
  context: {
    candidate_tasks?: { id: string; title: string }[];
    draft_extraction?: Partial<EmailAnalysis>;
    thread_snippet?: string;
    reasoning?: string;
  };
  status: "pending" | "answered" | "dismissed";
  answer: string | null;
  resulting_task_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ── Extraction types ──────────────────────────────────────────────────────────

/**
 * Rich structured result from analyzeInboundEmail().
 * Replaces the old ExtractedTaskData interface.
 */
export interface EmailAnalysis {
  classification: EmailClassification;
  confidence: number; // 0–1
  reasoning: string;  // short internal trail, not shown verbatim to user
  task_title: string | null;
  description: string | null;
  deadline: string | null; // YYYY-MM-DD or null
  priority: Priority | null;
  status_change: TaskStatus | null;
  matched_task_id: string | null;
  duplicate_of_task_id: string | null;
  depends_on_task_ids: string[];
  clarifying_question: string | null;
}

/**
 * @deprecated Use EmailAnalysis. Kept for backward compatibility with
 * any existing code paths that haven't been migrated yet.
 */
export interface ExtractedTaskData {
  has_task: boolean;
  task_title: string | null;
  deadline: string | null;
  priority: Priority | null;
  is_update_to_existing: boolean;
  matched_task_id: string | null;
  context_summary: string;
}

// ── Robin chat types ──────────────────────────────────────────────────────────

export interface RobinMessage {
  role: "user" | "assistant";
  content: string;
  action?: RobinAction;
  /** Set when this message is a proactive clarification question from Robin. */
  clarification_id?: string;
}

export interface RobinAction {
  type:
    | "update_task_deadline"
    | "update_task_status"
    | "create_task"
    | "update_task_priority"
    | "create_goal"
    | "delete_goal"
    | "delete_task";
  params: Record<string, string>;
  description: string;
  confirmed?: boolean;
}

export interface RobinChatSession {
  id: string;
  title: string;
  messages: RobinMessage[];
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

export interface RobinContext {
  goals: Goal[];
  tasks: Task[];
  recentEmails: Email[];
}

// ── Next-Auth session extension ───────────────────────────────────────────────

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      accessToken?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}
