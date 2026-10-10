# HackMate — Hackathon Team Collaboration Platform

HackMate is a web collaboration platform engineered specifically for hackathon teams of 4–6 members. It streamlines work distribution under a team leader and provides a central, private **Shared Work Library** where teammates upload and download code, trained machine learning models, datasets, frontend components, and backend endpoints without passing loose ZIP files or losing track of contributions.

---

## 1. Product Capabilities & MVP Scope

* **User Authentication**: Secure email and password registration, session cookie management, and profile resolution.
* **Team & Project Creation**: Project creation by a team leader with name, description, hackathon tag, and auto-generated unique invitation code.
* **Team Structure & Concurrency-Safe Limits**:
  * Designed strictly for hackathon teams of 4–6 people (1 leader + up to 5 members).
  * Hard database & mutex cap of **6 members max per project**.
  * Concurrent join attempts are atomically guarded against race conditions.
* **Leader-Controlled Task Management**:
  * Leader creates tasks, assigns teammates, specifies requirements, and sets deadlines.
  * Members update assigned tasks to `In Progress` or `Submitted`.
  * Leader reviews submissions to mark them as `Approved` or `Changes Requested`.
* **Shared Work Library (Core Feature)**:
  * Any project member can publish work with title, description, optional task association, version label (e.g. `v1.0.0`), usage instructions, dependencies, and file attachments.
  * Real-time search and filtering by title, contributor, and associated task.
  * Distinguishes latest upload from historical contributions without silent overwrites.
* **Private Storage & Byte-for-Byte File Downloads**:
  * Relational database stores file metadata and checksums (SHA-256).
  * Private object storage preserves binary integrity.
  * Authorization enforced at backend route and storage policy levels (cross-project downloads strictly blocked with 403 Forbidden).

---

## 2. Technical Stack

* **Frontend**: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Lucide Icons.
* **Backend**: Next.js Server Route Handlers with streaming file responses.
* **Access Control**: Role-based permissions (Leader vs Member) and project-scoped isolation.
* **Storage Drivers (Dual-Mode)**:
  1. **Local Persistent Driver (Default)**: Zero-config persistent JSON database (`data/hackmate.json`) and private local disk storage (`data/storage/`). Perfect for immediate testing and self-hosted environments.
  2. **Supabase Cloud Driver**: Supabase Auth, PostgreSQL with Row Level Security (RLS), and Supabase Private Object Storage (`hackmate-contributions`).

---

## 3. Project Structure

```
├── app/
│   ├── api/
│   │   ├── auth/ (register, login, logout, me)
│   │   ├── projects/
│   │   │   ├── route.ts (list & create projects)
│   │   │   ├── join/route.ts (join via invite code)
│   │   │   └── [id]/
│   │   │       ├── route.ts (project details & update)
│   │   │       ├── join/route.ts (project-scoped join)
│   │   │       ├── members/route.ts (roster)
│   │   │       ├── tasks/route.ts (create & list tasks)
│   │   │       ├── tasks/[taskId]/route.ts (status updates & review)
│   │   │       ├── contributions/route.ts (publish & list shared work)
│   │   │       ├── contributions/[contribId]/route.ts (contribution detail)
│   │   │       └── files/[fileId]/download/route.ts (private authorized download)
│   ├── dashboard/page.tsx (Screen A: Project dashboard)
│   ├── projects/[id]/page.tsx (Screen B: Project Overview)
│   ├── projects/[id]/tasks/page.tsx (Screen C: Task Pipeline & Reviews)
│   ├── projects/[id]/shared-work/page.tsx (Screen D: Shared Work Library)
│   ├── projects/[id]/team/page.tsx (Screen E: Team Roster & Invitations)
│   ├── login/page.tsx & register/page.tsx (Screen F: Authentication)
│   └── join/page.tsx (Direct invitation URL landing)
├── components/
│   ├── AuthProvider.tsx (Session state & hooks)
│   ├── Navbar.tsx (Global top header)
│   └── ProjectNav.tsx (Project navigation tabs)
├── lib/
│   ├── types.ts (Domain TypeScript interfaces)
│   ├── auth/session.ts (HMAC-signed session token manager)
│   ├── db/
│   │   ├── types.ts (IDatabaseAdapter interface)
│   │   ├── localDb.ts (Persistent JSON adapter with atomic locks)
│   │   ├── supabaseDb.ts (Supabase PostgreSQL adapter)
│   │   └── index.ts (Database adapter factory)
│   └── storage/
│       ├── types.ts (IStorageAdapter interface)
│       ├── localStorage.ts (Private disk storage with SHA-256)
│       ├── supabaseStorage.ts (Supabase private bucket adapter)
│       └── index.ts (Storage adapter factory)
├── supabase/
│   └── migrations/20241010_init_hackmate.sql (PostgreSQL schema, triggers, RLS)
├── tests/
│   ├── hackmate.test.ts (Core specification tests: Tests 1–11)
│   └── api.test.ts (HTTP route handler end-to-end test suite)
├── .env.example (Environment template)
└── _satellite_embedding_archive/ (Preserved historical workspace files)
```

---

## 4. Setup and Quickstart

### Prerequisites
* Node.js 18+ (tested on Node v24.18.1)
* npm 9+

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy the example environment file:
```bash
cp .env.example .env.local
```

Default configuration runs in persistent local mode without requiring external API keys:
```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=./data/storage
LOCAL_DB_PATH=./data/hackmate.json
MAX_UPLOAD_SIZE_MB=50
AUTH_SECRET=hackmate-local-session-secret-change-in-production
```

### 3. Run the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 5. Verification and Testing

### Run Automated Test Suite
HackMate includes an automated Vitest test suite executing the specification's acceptance criteria:

```bash
npm test
```

### Run Production Build & Typecheck
```bash
npx tsc --noEmit
npm run build
```

---

## 6. Supabase Cloud Configuration (Optional)

To connect HackMate to a live Supabase project:

1. Create a new Supabase project at [https://supabase.com](https://supabase.com).
2. Run the migration script in the Supabase SQL Editor:
   ```bash
   supabase/migrations/20241010_init_hackmate.sql
   ```
3. Set the environment variables in `.env.local`:
   ```env
   STORAGE_DRIVER=supabase
   NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
   SUPABASE_STORAGE_BUCKET=hackmate-contributions
   ```

---

## 7. Security and Access Control Matrix

| Action | Leader | Assigned Member | Other Team Member | Outside User |
| :--- | :---: | :---: | :---: | :---: |
| View Project & Roster | ✓ | ✓ | ✓ | ✗ (403) |
| Edit Project Details | ✓ | ✗ (403) | ✗ (403) | ✗ (403) |
| Create & Assign Tasks | ✓ | ✗ (403) | ✗ (403) | ✗ (403) |
| Update Status (`In Progress`/`Submitted`) | ✓ | ✓ | ✗ (403) | ✗ (403) |
| Review Task (`Approved`/`Changes Requested`) | ✓ | ✗ (403) | ✗ (403) | ✗ (403) |
| Publish Contribution & Upload Files | ✓ | ✓ | ✓ | ✗ (403) |
| Search & View Shared Library | ✓ | ✓ | ✓ | ✗ (403) |
| Download Contribution Files | ✓ | ✓ | ✓ | ✗ (403) |
| Join Project past 6-member limit | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) |
