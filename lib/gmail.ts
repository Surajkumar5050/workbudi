import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "./supabase";

function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXTAUTH_URL}/api/auth/callback/google`
  );
}

async function getAuthorizedClient(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("access_token, refresh_token, expires_at")
    .eq("id", userId)
    .single();

  if (error || !data) throw new Error("Google account not linked");

  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expires_at ? data.expires_at * 1000 : undefined,
  });

  // Persist refreshed tokens automatically
  oauth2Client.on("tokens", async (tokens) => {
    const patch: Record<string, string | number> = {};
    if (tokens.access_token) patch.access_token = tokens.access_token;
    if (tokens.expiry_date) patch.expires_at = Math.floor(tokens.expiry_date / 1000);
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin.from("users").update(patch).eq("id", userId);
    }
  });

  return oauth2Client;
}

function cleanHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextFromPayload(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";

  // If this part is plain text and has data
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  // Check sub-parts recursively
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
    // If no plain text subpart, look deeper
    for (const part of payload.parts) {
      const nested = extractTextFromPayload(part);
      if (nested) return nested;
    }
    // If only html found in subparts
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const rawHtml = Buffer.from(part.body.data, "base64").toString("utf-8");
        return cleanHtmlToText(rawHtml);
      }
    }
  }

  // If top-level is text/html
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const rawHtml = Buffer.from(payload.body.data, "base64").toString("utf-8");
    return cleanHtmlToText(rawHtml);
  }

  return "";
}

function parseMessage(messageId: string, msg: gmail_v1.Schema$Message) {
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

  const extractedBody = extractTextFromPayload(msg.payload);
  const snippet = msg.snippet ? cleanHtmlToText(msg.snippet) : "";
  const bodyText = extractedBody.trim() || snippet;

  return {
    gmail_message_id: messageId,
    thread_id: msg.threadId ?? "",
    subject: getHeader("subject") || "(no subject)",
    from_email: getHeader("from"),
    body_snippet: bodyText.slice(0, 1200) || "(No content)",
    received_at: new Date(parseInt(msg.internalDate ?? "0")).toISOString(),
  };
}

export async function getEmailById(userId: string, messageId: string) {
  const auth = await getAuthorizedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return parseMessage(messageId, data);
}

export async function fetchEmails(userId: string, maxResults = 20) {
  const auth = await getAuthorizedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "in:inbox",
  });

  const messages = listRes.data.messages ?? [];

  const emails = await Promise.all(
    messages.map(async (msg) => {
      const { data } = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "full",
      });
      return parseMessage(msg.id!, data);
    })
  );

  return emails;
}

export async function getLatestHistoryId(userId: string): Promise<string> {
  const auth = await getAuthorizedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return data.historyId ?? "";
}

export async function fetchNewEmailsSince(
  userId: string,
  historyId: string
): Promise<string[]> {
  const auth = await getAuthorizedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.history.list({
      userId: "me",
      startHistoryId: historyId,
      historyTypes: ["messageAdded"],
    });

    const history = res.data.history ?? [];
    const messageIds: string[] = [];

    for (const record of history) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) messageIds.push(added.message.id);
      }
    }

    return messageIds;
  } catch {
    return [];
  }
}
