import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { supabaseAdmin } from "@/lib/supabase";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret:
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "workbudi-nextauth-super-secret-key-prod-2026-fallback",
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID || "placeholder-client-id",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "placeholder-client-secret",
      authorization: {
        params: {
          scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;

        const email = profile.email as string;

        try {
          const { data: existing } = await supabaseAdmin
            .from("users")
            .select("id")
            .eq("email", email)
            .maybeSingle();

          if (existing) {
            token.userId = existing.id;

            const patch: Record<string, unknown> = {
              access_token: account.access_token ?? null,
              expires_at: account.expires_at ?? null,
            };
            if (account.refresh_token) {
              patch.refresh_token = account.refresh_token;
            }

            await supabaseAdmin
              .from("users")
              .update(patch)
              .eq("id", existing.id);
          } else {
            const { data: newUser, error: insertError } = await supabaseAdmin
              .from("users")
              .insert({
                email,
                name: profile.name ?? null,
                image: (profile as Record<string, unknown>).picture ?? null,
                access_token: account.access_token ?? null,
                refresh_token: account.refresh_token ?? null,
                expires_at: account.expires_at ?? null,
              })
              .select("id")
              .single();

            if (insertError) {
              console.error("[Auth] User insert error:", insertError);
            }
            if (newUser) token.userId = newUser.id;
          }
        } catch (dbErr) {
          console.error("[Auth] Database error in jwt callback:", dbErr);
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId as string;
      session.user.accessToken = token.accessToken as string;
      return session;
    },
  },
  pages: { signIn: "/login" },
});
