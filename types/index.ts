export type Priority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in-progress" | "done";
export type TaskSource = "manual" | "gmail";

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
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
  created_at: string;
  updated_at: string;
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
}

export interface ExtractedTaskData {
  has_task: boolean;
  task_title: string | null;
  deadline: string | null;
  priority: Priority | null;
  is_update_to_existing: boolean;
  matched_task_id: string | null;
  context_summary: string;
}

export interface RobinMessage {
  role: "user" | "assistant";
  content: string;
  action?: RobinAction;
}

export interface RobinAction {
  type: "update_task_deadline" | "update_task_status" | "create_task" | "update_task_priority" | "create_goal" | "delete_goal" | "delete_task";
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
