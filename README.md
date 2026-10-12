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
* **Common Development Workspace (Milestone 2)**:
  * Persistent hierarchical project file tree (folders & source files).
  * In-browser code and text editing with line numbers and syntax formatting.
  * Real-time save status indicators (`Saved`, `Unsaved changes`, `Saving...`, `Conflict Detected`).
  * Optimistic concurrency control & conflict detection to prevent silent teammate overwrites.
  * Full immutable revision history with author tracking and timestamps.
  * Non-destructive version recovery: restoring an earlier snapshot creates a new revision without destructive rollbacks.
  * Persistent disk mirror (`data/workspaces/{projectId}/`) alongside database records.
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
│   │   │       ├── files/[fileId]/download/route.ts (private authorized download)
│   │   │       └── workspace/
│   │   │           ├── tree/route.ts (workspace file tree)
│   │   │           ├── nodes/route.ts (create file/folder)
│   │   │           ├── nodes/[nodeId]/route.ts (rename/delete)
│   │   │           ├── files/[fileId]/route.ts (get & save with conflict detection)
│   │   │           ├── files/[fileId]/revisions/route.ts (immutable revision history)
│   │   │           └── files/[fileId]/restore/route.ts (non-destructive rollback)
│   ├── dashboard/page.tsx (Screen A: Project dashboard)
│   ├── projects/[id]/page.tsx (Screen B: Project Overview)
│   ├── projects/[id]/workspace/page.tsx (Common Development Workspace)
│   ├── projects/[id]/tasks/page.tsx (Screen C: Task Pipeline & Reviews)
│   ├── projects/[id]/shared-work/page.tsx (Screen D: Shared Work Library)
│   ├── projects/[id]/team/page.tsx (Screen E: Team Roster & Invitations)
│   ├── login/page.tsx & register/page.tsx (Screen F: Authentication)
│   └── join/page.tsx (Direct invitation URL landing)
├── components/
│   ├── AuthProvider.tsx (Session state & hooks)
│   ├── Navbar.tsx (Global top header)
│   └── ProjectNav.tsx (Project navigation tabs with Workspace)
├── lib/
│   ├── types.ts (Domain TypeScript interfaces)
│   ├── auth/session.ts (Hardened session token manager)
│   ├── db/
│   │   ├── types.ts (IDatabaseAdapter interface)
│   │   ├── localDb.ts (Persistent JSON adapter with atomic locks & workspace)
│   │   ├── supabaseDb.ts (Supabase PostgreSQL adapter with workspace)
│   │   └── index.ts (Database adapter factory)
│   └── storage/
│       ├── types.ts (IStorageAdapter interface)
│       ├── localStorage.ts (Private disk storage with SHA-256)
│       ├── supabaseStorage.ts (Supabase private bucket adapter)
│       └── index.ts (Storage adapter factory)
├── supabase/
│   └── migrations/
│       ├── 20241010_init_hackmate.sql (Initial HackMate database schema, triggers, RLS)
│       ├── 20241011_add_workspace.sql (Common Development Workspace nodes & revisions schema)
│       └── 20241012_harden_workspace_security_and_rpc.sql (Workspace security and atomic RPC hardening)
├── tests/
│   ├── hackmate.test.ts (Core specification tests: Tests 1–11)
│   ├── api.test.ts (HTTP route handler end-to-end test suite)
│   ├── workspace.test.ts (Common Development Workspace acceptance tests: W1–W9)
│   ├── workspace_review.test.ts (Workspace concurrency, path traversal & authorization tests)
│   ├── auth_session.test.ts (Production AUTH_SECRET hardening & session validation)
│   ├── postgres_safety.test.ts (PostgreSQL test harness isolation & teardown safety)
│   └── postgres_integration.test.ts (Disposable PostgreSQL migration & RPC integration)
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

> [!NOTE]
> For production deployments (`NODE_ENV=production`), `AUTH_SECRET` must be at least 32 bytes and cannot use default, placeholder, single-character, or predictable repeating patterns. Note that string validation enforces minimum length and rejects obvious weak patterns but cannot prove cryptographic entropy; operators must generate a cryptographically random secret using:
> ```bash
> openssl rand -base64 32
> ```

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

### Run PostgreSQL Disposable Integration Harness
```bash
npm run test:postgres
```

### Run Production Build & Typecheck
```bash
npx tsc --noEmit
npm run build
```

---

## 6. Storage Driver & Database Configuration

HackMate supports two storage backends:
1. **Local Persistent Driver (`STORAGE_DRIVER=local`)**:
   - Zero-config persistent JSON database (`data/hackmate.json`) and private local disk storage (`data/storage/`).
   - Defaults automatically in local development (`NODE_ENV=development`).
   - Supported for self-hosted production environments (e.g. Docker, VPS) with explicitly configured persistent writable volumes.
2. **Supabase Cloud Driver (`STORAGE_DRIVER=supabase`)**:
   - Supabase PostgreSQL with Row Level Security (RLS) and Supabase Private Object Storage (`hackmate-contributions`).
   - **Mandatory for Vercel deployments**: Serverless functions run on ephemeral filesystems where local files are wiped between cold starts and instances. To protect student collaboration data, Vercel deployments strictly require an explicitly configured persistent database (`STORAGE_DRIVER=supabase`).
   - **Fail-Closed Production Safeguards**: In production (`NODE_ENV=production`), `STORAGE_DRIVER` must be explicitly configured. Missing or invalid database configuration never silently falls back to local JSON storage. If `STORAGE_DRIVER=supabase` is configured but Supabase credentials cannot initialize the admin client, the system fails closed with a clear configuration error without exposing secret values.

If you choose to connect HackMate to a live Supabase project (`STORAGE_DRIVER=supabase`):

> [!IMPORTANT]
> The database migrations **must be applied sequentially in the exact order below** before using the Common Development Workspace with Supabase. The final migration contains critical database security policies and atomic stored procedures. Omitting migrations or applying them out of order will leave a deployment without the complete workspace schema and required security functions.

1. **Create Supabase Project & Storage Bucket**:
   - Create a new project at [https://supabase.com](https://supabase.com).
   - In the Supabase Storage dashboard, create a private bucket named `hackmate-contributions`.

2. **Execute Database Migrations in the Supabase SQL Editor**:
   In your browser, open the Supabase dashboard for your project, navigate to the **SQL Editor**, and execute the full contents of each file in this exact sequential order:

   * **Step 1 — Initial HackMate database schema & Distributed Rate Limiting**:
     Open [`supabase/migrations/20241010_init_hackmate.sql`](supabase/migrations/20241010_init_hackmate.sql), copy its SQL contents, and run them in the SQL Editor.  
     Provisions foundational schemas (`users`, `profiles`, `projects`, `project_members`, `tasks`, `contributions`, `contribution_files`, `auth_rate_limits`), membership cap triggers, private storage metadata, atomic `check_rate_limit` stored procedure, and Row Level Security (RLS) policies.

   * **Step 2 — Common Development Workspace schema**:
     Open [`supabase/migrations/20241011_add_workspace.sql`](supabase/migrations/20241011_add_workspace.sql), copy its SQL contents, and run them in the SQL Editor.  
     Creates hierarchical workspace file tree nodes (`workspace_nodes`), immutable file revisions (`workspace_revisions`), and project workspace constraints.

   * **Step 3 — Workspace security and atomic RPC hardening**:
     Open [`supabase/migrations/20241012_harden_workspace_security_and_rpc.sql`](supabase/migrations/20241012_harden_workspace_security_and_rpc.sql), copy its SQL contents, and run them in the SQL Editor.  
     Defines the hardened workspace database functions:
     * `workspace_calculate_checksum(p_content TEXT)` — SHA-256 content digest verification.
     * `create_workspace_node_atomic(...)` — Atomic file/folder node creation with path validation and initial revision generation.
     * `save_workspace_file_atomic(...)` — Atomic file saving with row-level locking (`SELECT ... FOR UPDATE` on `workspace_nodes`), optimistic concurrency control (`p_base_revision`), and revision insertion.
     * `update_workspace_node_atomic(...)` — Atomic node rename and recursive path propagation.
     * `delete_workspace_node_atomic(...)` — Atomic soft deletion with recursive descendant traversal.

     *(Note: File revision restoration is handled at the application adapter level: `SupabaseDatabaseAdapter.restoreWorkspaceRevision()` retrieves the historical revision from `workspace_revisions` and calls `saveWorkspaceFile()`, which executes `save_workspace_file_atomic` to create a new revision non-destructively.)*

3. **Configure Environment Variables (Vercel Deployments & `.env.local`)**:
   For Vercel deployments, configure these exact environment variables in your Vercel Project Settings (or via `vercel env add`):
   ```env
   # Mandatory Production Storage & Authentication Secrets
   STORAGE_DRIVER=supabase
   NEXT_PUBLIC_SUPABASE_URL=<real Supabase project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<real Supabase anon key>
   SUPABASE_SERVICE_ROLE_KEY=<real Supabase service-role key>
   AUTH_SECRET=<strong randomly generated production secret (min 32 bytes)>

   # Production Email Verification & Rate Limiting Options
   AUTH_AUTO_CONFIRM_EMAILS=false # Defaults to false in production (requires email confirmation). Set true to auto-confirm signups.
   UPSTASH_REDIS_REST_URL=<optional Upstash Redis REST URL for distributed rate limiting>
   UPSTASH_REDIS_REST_TOKEN=<optional Upstash Redis REST Token>
   ```

   *(Optional: `SUPABASE_STORAGE_BUCKET=hackmate-contributions`, defaults to `hackmate-contributions`)*

   > [!WARNING]
   > - `SUPABASE_SERVICE_ROLE_KEY` is a sensitive backend administrative secret and must **never** be prefixed with `NEXT_PUBLIC_` or exposed to browser code.
   > - `AUTH_SECRET` is mandatory for production and must be generated using a cryptographically secure random generator:
   >   ```bash
   >   openssl rand -base64 32
   >   ```

> [!NOTE]
> Database migrations and RPC functions are verified against disposable PostgreSQL instances in automated CI quality gates (`npm run test:postgres`). Live Supabase cloud connectivity requires providing active project credentials as detailed above.

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

### Defense-in-Depth Architecture & Authorization Safeguards

1. **Supabase Client Isolation**:
   * **Authentication Client**: A public, stateless client initialized with `NEXT_PUBLIC_SUPABASE_ANON_KEY` configured strictly with `autoRefreshToken: false`, `persistSession: false`, and `detectSessionInUrl: false`. Used exclusively to verify user login credentials (`signInWithPassword`).
   * **Administrative Client**: Isolated service-role client (`SUPABASE_SERVICE_ROLE_KEY`) used exclusively on the server for privileged database operations, ensuring user logins cannot contaminate or alter administrative query authorization contexts.
2. **Strict Application-Level Authorization (Model B)**:
   * Every API route handler and database adapter method explicitly verifies user authentication, active project membership (`isProjectMember`), role authority (`isProjectLeader`), and task assignee validity before performing operations.
   * Tasks and contributions enforce strict project boundaries: assigning tasks to non-members, modifying tasks across projects, or linking foreign-project tasks when publishing contributions fails closed with 400/403 errors.
3. **Session Token Hardening & HTTP-Only Isolation**:
   * Authenticated sessions use cryptographically verified HMAC-SHA256 tokens stored exclusively in `HttpOnly`, `SameSite=Lax`, `Secure` cookies (`hackmate_session`).
   * `/api/auth/refresh` rotates the session cookie and strictly omits raw token strings from the JSON response body, preventing XSS-based token theft.
4. **Distributed Multi-Instance Rate Limiting & Bounded Cleanup**:
   * `/api/auth/login` and `/api/auth/register` utilize atomic rate limiting (10 requests/minute) backed by PostgreSQL RPC (`public.check_rate_limit`) with optional Upstash Redis pipeline support and local memory fallback.
   * Client IPs are extracted through trusted hosting proxy headers (`x-vercel-forwarded-for`, `x-real-ip`). Node's native `net.isIP()` reliably parses IPv4 and IPv6 addresses without loopback fallback.
   * **Atomic Concurrency**: A single atomic `INSERT ... ON CONFLICT (key) DO UPDATE ... RETURNING` prevents race conditions across concurrent serverless instances.
   * **SECURITY DEFINER Hardening**: Functions run with restricted empty search path (`SET search_path = ''`) and full schema qualification to eliminate search-path hijacking risks. Execution is revoked from `PUBLIC, anon, authenticated` and granted exclusively to `service_role`.
   * **Automated Cleanup Architecture (`public.cleanup_expired_rate_limits()`)**:
     * *Non-Destructive Retention*: Prunes rate-limit records whose `reset_at` timestamp is older than 1 hour; active windows are never deleted.
     * *Bounded Background Sweep*: Built-in opportunistic cleanup in `lib/auth/rateLimit.ts` throttles database cleanup to execute at most once per 15-minute cooldown window, running asynchronously without blocking client requests.
     * *Protected Maintenance Endpoint*: An authenticated maintenance endpoint at `/api/cron/cleanup-rate-limits` requires `Authorization: Bearer <CRON_SECRET>` or Vercel Cron headers, blocking unauthenticated callers with HTTP 401.
     * *Optional Database Scheduler (`pg_cron`)*: On Supabase, operators can automate hourly pruning directly within PostgreSQL:
       ```sql
       -- Optional pg_cron setup in Supabase SQL editor:
       SELECT cron.schedule(
           'cleanup-expired-rate-limits',
           '0 * * * *',
           'SELECT public.cleanup_expired_rate_limits();'
       );
       ```


---

## 8. Backup & Disaster Recovery Procedures

### Supabase Production Backups
1. **Automated Point-in-Time Recovery (PITR)**:
   - In the Supabase project dashboard (**Database > Backups**), enable Point-in-Time Recovery (PITR) to maintain continuous physical WAL logging and allow minute-by-minute restoration.
2. **Scheduled Snapshot Dumps**:
   - Operators should automate daily logical schema and data exports using `pg_dump` over the direct PostgreSQL connection:
     ```bash
     pg_dump -h db.<project-ref>.supabase.co -U postgres -d postgres -F c -b -v -f "hackmate_backup_$(date +%Y%m%d_%H%M%S).dump"
     ```
   - Store dump artifacts in an encrypted off-site cloud storage bucket (AWS S3 Glacier or Google Cloud Storage) with a 30-day lifecycle retention policy.
3. **Disaster Recovery Restore**:
   - To restore from a logical backup file into a recovery target database:
     ```bash
     pg_restore -h db.<recovery-ref>.supabase.co -U postgres -d postgres -v -c "hackmate_backup_<timestamp>.dump"
     ```
4. **Contribution Object Storage Recovery**:
   - Enable object versioning on the `hackmate-contributions` bucket in Supabase / S3 to guard against accidental deletions or overwrites.
   - Retain cross-region replication for mission-critical file assets.

---

## 9. Campus Launch Bottlenecks & Scaling Analysis

During a high-traffic college campus launch or hackathon kickoff (hundreds of students concurrently creating projects, submitting tasks, and editing files), operators should monitor and prepare for these identified system bottlenecks:

1. **Serverless Connection Pool Exhaustion**:
   - *Risk*: Next.js API routes deployed on Vercel scale horizontally across dozens of concurrent serverless container instances. Each instance creating separate persistent PostgreSQL connections can exhaust database connection slots.
   - *Mitigation*: Ensure `NEXT_PUBLIC_SUPABASE_URL` and backend connections route through Supabase's transaction pooler (Supavisor on port 6543) rather than the direct connection port (5432).
2. **Concurrent Team Roster Contention (Atomic 6-Member Cap)**:
   - *Behavior*: `check_project_member_limit()` acquires a row-level lock on `public.projects (FOR UPDATE)` to serialize concurrent joins and enforce the 6-member team ceiling without race conditions.
   - *Impact*: Under extreme concurrent joins for the same project, requests serialize cleanly. Requests exceeding 6 members immediately fail closed with an explicit 409 Conflict.
3. **Common Development Workspace Revision Conflicts**:
   - *Behavior*: Workspace file saves enforce optimistic concurrency control via `baseRevision` comparisons in `save_workspace_file_atomic()`.
   - *Impact*: When multiple students concurrently edit the same workspace file, the second writer receives a `409 Conflict` containing the latest revision. Students must pull the current version before resubmitting.
4. **Authentication & Registration Rate Limits**:
   - *Protection*: `/api/auth/register` and `/api/auth/login` enforce sliding-window IP rate limiting (10 requests per minute). Excess requests receive `429 Too Many Requests` with a `Retry-After` header to mitigate credential stuffing and DoS spikes.
5. **Unbounded Query Degradation (Mitigated via Pagination)**:
   - *Optimization*: Database list endpoints (`/api/projects`, `/api/projects/[id]/tasks`, `/api/projects/[id]/contributions`, and workspace revisions) support `?limit=...&offset=...` query parameters, backed by secondary PostgreSQL indexes on foreign keys (`project_id`, `user_id`, `assigned_to`, `contributor_id`).
6. **Health & Uptime Monitoring**:
   - *Probe*: Uptime monitors should poll `/api/health`, which performs a live query probe against storage and database backends and reports response latency.

