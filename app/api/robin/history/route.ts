import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("robin_messages")
    .select("*")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: true });

  if (error) {
    // If table doesn't exist yet, return empty list
    return NextResponse.json([]);
  }

  return NextResponse.json(data ?? []);
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabaseAdmin
    .from("robin_messages")
    .delete()
    .eq("user_id", session.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
