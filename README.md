# WorkBudi 🚀

An AI-powered work assistant that connects Gmail to a task management workspace, and uses Robin — an AI agent — to help you understand, prioritize, and execute on your work.

---

## 🎯 The Core WorkBudi Loop

```
Gmail (Inbound) → WorkBudi AI Understanding → Workspace Tasks Update → Robin Prioritization & Controlled Actions
```

1. **Workspace** — Set goals. Manage tasks with priorities, deadlines, and statuses across a responsive 3-column Kanban board.
2. **Gmail Integration** — Real Google OAuth 2.0 connection, real email fetching, and live delta polling via Gmail `historyId`.
3. **Work Understanding** — Gemini AI parses incoming emails, extracts action items & deadlines, and performs thread-aware deduplication (updating existing tasks rather than creating duplicates).
4. **Robin AI Assistant** — Multi-session ChatGPT-style interface with full workspace context reasoning, Markdown typography, and clarifying question handling.
5. **Controlled Tool Actions** — Robin proposes workspace actions (e.g. reschedule deadlines, change task status) with a strict human-in-the-loop confirmation UI.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router) + React 19 + TypeScript |
| **Auth** | NextAuth v5 (Beta) + Google OAuth 2.0 |
| **Database** | Supabase (PostgreSQL + RLS) |
| **AI Engine** | Google Gemini Flash with resilient local context fallback |
| **Gmail** | Google APIs (`googleapis`) |
| **Styling** | Custom Warm-Neutral Dark Design System (Vanilla CSS + Tailwind) |

---

## 📂 Project Architecture

```
workbudi/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]   — Google OAuth handlers & token persistence
│   │   ├── goals                — Goals CRUD
│   │   ├── tasks                — Tasks CRUD
│   │   ├── gmail/
│   │   │   ├── fetch            — Initial email load + AI extraction
│   │   │   ├── poll             — Delta polling using Gmail historyId
│   │   │   └── list             — Cached email retrieval from Supabase
│   │   └── robin/
│   │       ├── chat             — Real-time streaming chat & tool execution
│   │       └── history          — Chat session persistence
│   ├── dashboard/               — Workspace Goals & Kanban board
│   ├── gmail/                   — Gmail inbox list & responsive reading pane
│   ├── robin/                   — Multi-session ChatGPT-style Robin AI chat
│   └── login/                   — Clean centered OAuth login
├── components/
│   ├── Navbar.tsx               — Responsive navigation
│   └── Providers.tsx            — Session & React context providers
├── lib/
│   ├── supabase.ts              — Supabase client & service role admin
│   ├── gmail.ts                 — Gmail API wrapper & plain text body parser
│   ├── gemini.ts                — Task extraction & Robin reasoning engine
│   └── tools.ts                 — Controlled tool execution & status normalizer
└── supabase/
    └── schema.sql               — PostgreSQL database schema
```

---

## 🚀 Quickstart & Local Setup

### 1. Clone & Install Dependencies
```bash
git clone <your-repo-url>
cd workbudi
npm install
```

### 2. Environment Configuration
Create `.env.local` based on `.env.example`:
```bash
cp .env.example .env.local
```

Fill in your credentials:
```env
NEXTAUTH_URL=http://localhost:3000
AUTH_SECRET=your_generated_secret

GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret

NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

GEMINI_API_KEY=your_google_gemini_api_key
```

### 3. Database Migration
Run the SQL script located in `supabase/schema.sql` in your Supabase SQL Editor.

### 4. Run Development Server
```bash
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

## 🎬 How to Run the End-to-End Demo

1. **Sign in**: Login with Google at `/login`.
2. **Workspace**: Create a high-level goal on `/dashboard`.
3. **Gmail Ingest**: Navigate to `/gmail` and click **"Fetch Emails"**. Watch tasks get extracted with absolute deadlines.
4. **Deduplication Test**: Start live polling on `/gmail`, reply to an existing email thread in your Gmail client, and verify that WorkBudi updates the existing task rather than creating a duplicate.
5. **Robin Reasoning**: Go to `/robin` and ask *"What should I work on today?"*.
6. **Execute Action**: Ask Robin to *"Shift the top task to in-progress"*, review the proposed action card, and click **"✓ Confirm & Execute"**. Verify the update in your Workspace.
