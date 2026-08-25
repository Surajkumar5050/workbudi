"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setLoading(true);
    await signIn("google", { callbackUrl: "/dashboard" });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: "-0.5px",
              color: "var(--text-primary)",
              marginBottom: 6,
            }}
          >
            Work<span style={{ color: "var(--accent)" }}>Budi</span>
          </div>
          <p style={{ color: "var(--text-secondary)", fontSize: 15 }}>
            Your AI-powered work assistant
          </p>
        </div>

        {/* Card */}
        <div
          className="card"
          style={{
            padding: "36px 32px",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 16px 48px rgba(0, 0, 0, 0.4)",
          }}
        >
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "var(--text-primary)",
              marginBottom: 8,
              letterSpacing: "-0.3px",
            }}
          >
            Sign in to continue
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 14,
              lineHeight: 1.6,
              marginBottom: 28,
            }}
          >
            WorkBudi connects to Gmail to understand your work, extract tasks, and let Robin help you prioritize.
          </p>

          <button
            className="btn btn-primary"
            style={{
              width: "100%",
              padding: "13px 20px",
              fontSize: 15,
              fontWeight: 600,
              borderRadius: 10,
              gap: 12,
            }}
            onClick={handleSignIn}
            disabled={loading}
          >
            {loading ? (
              <div className="spinner" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            <span>{loading ? "Connecting to Google…" : "Continue with Google"}</span>
          </button>

          <p
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              textAlign: "center",
              marginTop: 20,
              lineHeight: 1.5,
            }}
          >
            Requires Gmail read access to fetch and analyze your emails. Your data stays securely in your account.
          </p>
        </div>
      </div>
    </div>
  );
}
