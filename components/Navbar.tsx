"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

const links = [
  { href: "/dashboard", label: "Workspace" },
  { href: "/gmail",     label: "Gmail"     },
  { href: "/robin",     label: "Robin"     },
];

export default function Navbar({ userName }: { userName?: string | null }) {
  const pathname = usePathname();
  return (
    <nav
      style={{
        background: "var(--bg-card)",
        borderBottom: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        zIndex: 30,
        width: "100%",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "0 16px",
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        {/* Left: Brand + Nav Links */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, minWidth: 0 }}>
          <Link
            href="/dashboard"
            style={{
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: "-0.5px",
              color: "var(--text-primary)",
              textDecoration: "none",
              flexShrink: 0,
            }}
          >
            Rob<span style={{ color: "var(--accent)" }}>in</span>
          </Link>

          <div style={{ display: "flex", gap: 16, overflowX: "auto" }}>
            {links.map(({ href, label }) => {
              const active = pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  style={{
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    textDecoration: "none",
                    paddingBottom: 4,
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    transition: "color 0.15s",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Right: Sign Out */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {userName && (
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                maxWidth: 100,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              className="hidden sm:inline"
            >
              {userName}
            </span>
          )}
          <button
            className="btn btn-ghost"
            style={{ padding: "6px 10px", fontSize: 12 }}
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
