-- ==============================================================================
-- HACKMATE: Common Development Workspace Migration
-- Migration: 20241011_add_workspace.sql
-- ==============================================================================

-- 1. WORKSPACE NODES (Hierarchical Files and Folders)
CREATE TYPE workspace_node_type AS ENUM ('file', 'folder');

CREATE TABLE IF NOT EXISTS public.workspace_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES public.workspace_nodes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    type workspace_node_type NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 1,
    last_modified_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    last_modified_name TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_project_active_path
    ON public.workspace_nodes (project_id, path)
    WHERE deleted_at IS NULL;

ALTER TABLE public.workspace_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace nodes"
    ON public.workspace_nodes FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

CREATE POLICY "Members can create workspace nodes"
    ON public.workspace_nodes FOR INSERT
    TO authenticated
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        last_modified_by = auth.uid()
    );

CREATE POLICY "Members can update workspace nodes"
    ON public.workspace_nodes FOR UPDATE
    TO authenticated
    USING (is_project_member(project_id, auth.uid()))
    WITH CHECK (is_project_member(project_id, auth.uid()));

CREATE POLICY "Members can delete workspace nodes"
    ON public.workspace_nodes FOR DELETE
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

-- 2. WORKSPACE REVISIONS (Immutable History and Recovery)
CREATE TABLE IF NOT EXISTS public.workspace_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES public.workspace_nodes(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    author_name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_node_revision UNIQUE (node_id, revision_number)
);

ALTER TABLE public.workspace_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace revisions"
    ON public.workspace_revisions FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

CREATE POLICY "Members can insert workspace revisions"
    ON public.workspace_revisions FOR INSERT
    TO authenticated
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        author_id = auth.uid()
    );

-- Index for speedy file history and tree navigation
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_project ON public.workspace_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_parent ON public.workspace_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_workspace_revisions_node ON public.workspace_revisions(node_id, revision_number DESC);
