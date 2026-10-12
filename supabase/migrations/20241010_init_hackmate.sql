-- ==============================================================================
-- HACKMATE: PostgreSQL Database Schema & Row Level Security (RLS) Policies
-- Migration: 20241010_init_hackmate.sql
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USERS / PROFILES TABLE
-- Mirrors auth.users in Supabase or operates standalone
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable by authenticated users"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = id);

-- 3. PROJECTS TABLE
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    hackathon_name TEXT,
    invite_code TEXT NOT NULL UNIQUE,
    leader_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- 4. PROJECT MEMBERSHIPS TABLE
CREATE TYPE project_role AS ENUM ('leader', 'member');

CREATE TABLE IF NOT EXISTS public.project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role project_role NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_project_user UNIQUE (project_id, user_id)
);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- CRITICAL REQUIREMENT: Strict 6-member limit per project
-- Enforced via a concurrency-safe PostgreSQL trigger with table locking
CREATE OR REPLACE FUNCTION check_project_member_limit()
RETURNS TRIGGER AS $$
DECLARE
    current_count INTEGER;
BEGIN
    -- Acquire advisory or row-level lock on the project to prevent race conditions
    PERFORM 1 FROM public.projects WHERE id = NEW.project_id FOR UPDATE;

    SELECT COUNT(*) INTO current_count
    FROM public.project_members
    WHERE project_id = NEW.project_id;

    IF current_count >= 6 THEN
        RAISE EXCEPTION 'Team is full. A hackathon project cannot have more than 6 members (1 leader and up to 5 teammates).';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_project_member_limit ON public.project_members;
CREATE TRIGGER trigger_check_project_member_limit
    BEFORE INSERT ON public.project_members
    FOR EACH ROW
    EXECUTE FUNCTION check_project_member_limit();

-- Helper function to check project membership
CREATE OR REPLACE FUNCTION is_project_member(_project_id UUID, _user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.project_members
        WHERE project_id = _project_id AND user_id = _user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_project_leader(_project_id UUID, _user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.project_members
        WHERE project_id = _project_id AND user_id = _user_id AND role = 'leader'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS for Projects
CREATE POLICY "Members can view their projects"
    ON public.projects FOR SELECT
    TO authenticated
    USING (
        leader_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.project_members
            WHERE project_members.project_id = projects.id
            AND project_members.user_id = auth.uid()
        )
    );

CREATE POLICY "Authenticated users can create projects"
    ON public.projects FOR INSERT
    TO authenticated
    WITH CHECK (leader_id = auth.uid());

CREATE POLICY "Leaders can update their projects"
    ON public.projects FOR UPDATE
    TO authenticated
    USING (leader_id = auth.uid())
    WITH CHECK (leader_id = auth.uid());

-- RLS for Project Members
CREATE POLICY "Members can view members of their projects"
    ON public.project_members FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = project_members.project_id
            AND pm.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can join via invitation code or leader can add"
    ON public.project_members FOR INSERT
    TO authenticated
    WITH CHECK (
        -- Either self joining or leader adding
        user_id = auth.uid() OR
        is_project_leader(project_id, auth.uid())
    );

-- 5. TASKS TABLE
CREATE TYPE task_status AS ENUM (
    'Assigned',
    'In Progress',
    'Submitted',
    'Changes Requested',
    'Approved'
);

CREATE TABLE IF NOT EXISTS public.tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assigned_to UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    status task_status NOT NULL DEFAULT 'Assigned',
    deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view tasks in their projects"
    ON public.tasks FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

CREATE POLICY "Leaders can insert tasks"
    ON public.tasks FOR INSERT
    TO authenticated
    WITH CHECK (is_project_leader(project_id, auth.uid()));

CREATE POLICY "Leaders and assignees can update tasks with permitted statuses"
    ON public.tasks FOR UPDATE
    TO authenticated
    USING (is_project_member(project_id, auth.uid()))
    WITH CHECK (
        -- Leader can update any field
        is_project_leader(project_id, auth.uid()) OR
        -- Assigned member can update status to 'In Progress' or 'Submitted'
        (
            assigned_to = auth.uid() AND
            status IN ('In Progress', 'Submitted')
        )
    );

-- 6. CONTRIBUTIONS TABLE (SHARED WORK)
CREATE TABLE IF NOT EXISTS public.contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    contributor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    contributor_name TEXT NOT NULL,
    task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
    version_label TEXT,
    usage_instructions TEXT NOT NULL DEFAULT '',
    dependencies TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view contributions in their project"
    ON public.contributions FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

CREATE POLICY "Project members can publish contributions"
    ON public.contributions FOR INSERT
    TO authenticated
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        contributor_id = auth.uid()
    );

-- 7. CONTRIBUTION FILES TABLE
CREATE TABLE IF NOT EXISTS public.contribution_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contribution_id UUID NOT NULL REFERENCES public.contributions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.contribution_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view file records in their project"
    ON public.contribution_files FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

CREATE POLICY "Members can insert file records in their project"
    ON public.contribution_files FOR INSERT
    TO authenticated
    WITH CHECK (is_project_member(project_id, auth.uid()));

-- 8. SUPABASE STORAGE BUCKET & STORAGE POLICIES
-- Create private bucket for hackmate contributions
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'hackmate-contributions',
    'hackmate-contributions',
    false, -- MUST BE PRIVATE OBJECT STORAGE
    52428800, -- 50MB limit per file
    NULL
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: Download only for authorized project members
CREATE POLICY "Project members can download private contribution files"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'hackmate-contributions' AND
        is_project_member((storage.foldername(name))[1]::uuid, auth.uid())
    );

-- Storage RLS: Upload only for authorized project members
CREATE POLICY "Project members can upload private contribution files"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'hackmate-contributions' AND
        is_project_member((storage.foldername(name))[1]::uuid, auth.uid())
    );

-- 9. PERFORMANCE INDEXES (High-Traffic Multi-User Optimization)
CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON public.tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_contributions_project ON public.contributions(project_id);
CREATE INDEX IF NOT EXISTS idx_contribution_files_project ON public.contribution_files(project_id);
CREATE INDEX IF NOT EXISTS idx_contribution_files_contrib ON public.contribution_files(contribution_id);

