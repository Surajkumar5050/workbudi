import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
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

        const { data: existing } = await supabase
          .from("users")
          .select("id")
          .eq("email", email)
          .maybeSingle();

        if (existing) {
          token.userId = existing.id;

          await supabase
            .from("users")
            .update({
              access_token: account.access_token,
              refresh_token: account.refresh_token,
              expires_at: account.expires_at,
            })
            .eq("id", existing.id);
        } else {
          const { data: newUser } = await supabase
            .from("users")
            .insert({
              email,
              name: profile.name,
              image: profile.picture,
              access_token: account.access_token,
              refresh_token: account.refresh_token,
              expires_at: account.expires_at,
            })
            .select("id")
            .single();

          if (newUser) token.userId = newUser.id;
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
