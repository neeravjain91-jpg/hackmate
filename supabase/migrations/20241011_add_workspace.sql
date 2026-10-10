-- ==============================================================================
-- HACKMATE: Common Development Workspace Migration
-- Migration: 20241011_add_workspace.sql
-- ==============================================================================

-- 1. WORKSPACE NODES (Hierarchical Files and Folders)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_node_type') THEN
        CREATE TYPE workspace_node_type AS ENUM ('file', 'folder');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.workspace_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    parent_id UUID,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    type workspace_node_type NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 1,
    last_modified_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    last_modified_name TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_workspace_nodes_id_project UNIQUE (id, project_id),
    CONSTRAINT fk_workspace_nodes_parent_project
        FOREIGN KEY (parent_id, project_id)
        REFERENCES public.workspace_nodes(id, project_id)
        ON DELETE CASCADE
);

-- Ensure composite uniqueness and foreign key exist if table was already created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_workspace_nodes_id_project'
    ) THEN
        ALTER TABLE public.workspace_nodes
            ADD CONSTRAINT uq_workspace_nodes_id_project UNIQUE (id, project_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_workspace_nodes_parent_project'
    ) THEN
        ALTER TABLE public.workspace_nodes
            ADD CONSTRAINT fk_workspace_nodes_parent_project
            FOREIGN KEY (parent_id, project_id)
            REFERENCES public.workspace_nodes(id, project_id)
            ON DELETE CASCADE;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS unique_project_active_path
    ON public.workspace_nodes (project_id, path)
    WHERE deleted_at IS NULL;

ALTER TABLE public.workspace_nodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view workspace nodes" ON public.workspace_nodes;
CREATE POLICY "Members can view workspace nodes"
    ON public.workspace_nodes FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

DROP POLICY IF EXISTS "Members can create workspace nodes" ON public.workspace_nodes;
CREATE POLICY "Members can create workspace nodes"
    ON public.workspace_nodes FOR INSERT
    TO authenticated
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        last_modified_by = auth.uid()
    );

DROP POLICY IF EXISTS "Members can update workspace nodes" ON public.workspace_nodes;
CREATE POLICY "Members can update workspace nodes"
    ON public.workspace_nodes FOR UPDATE
    TO authenticated
    USING (is_project_member(project_id, auth.uid()))
    WITH CHECK (is_project_member(project_id, auth.uid()));

DROP POLICY IF EXISTS "Members can delete workspace nodes" ON public.workspace_nodes;
DROP POLICY IF EXISTS "Leaders can hard delete workspace nodes" ON public.workspace_nodes;
CREATE POLICY "Leaders can hard delete workspace nodes"
    ON public.workspace_nodes FOR DELETE
    TO authenticated
    USING (is_project_leader(project_id, auth.uid()));

-- 2. WORKSPACE REVISIONS (Immutable History and Recovery)
CREATE TABLE IF NOT EXISTS public.workspace_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    author_name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_node_revision UNIQUE (node_id, revision_number),
    CONSTRAINT fk_workspace_revisions_node_project
        FOREIGN KEY (node_id, project_id)
        REFERENCES public.workspace_nodes(id, project_id)
        ON DELETE RESTRICT
);

-- Ensure composite foreign key on revisions exists if table was already created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_workspace_revisions_node_project'
    ) THEN
        ALTER TABLE public.workspace_revisions
            ADD CONSTRAINT fk_workspace_revisions_node_project
            FOREIGN KEY (node_id, project_id)
            REFERENCES public.workspace_nodes(id, project_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

ALTER TABLE public.workspace_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view workspace revisions" ON public.workspace_revisions;
CREATE POLICY "Members can view workspace revisions"
    ON public.workspace_revisions FOR SELECT
    TO authenticated
    USING (is_project_member(project_id, auth.uid()));

DROP POLICY IF EXISTS "Members can insert workspace revisions" ON public.workspace_revisions;
CREATE POLICY "Members can insert workspace revisions"
    ON public.workspace_revisions FOR INSERT
    TO authenticated
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        author_id = auth.uid()
    );

-- Revision Immutability Protection: Historical records cannot be modified or deleted
CREATE OR REPLACE FUNCTION prevent_workspace_revision_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Workspace revisions are immutable historical records and cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_workspace_revisions_immutable ON public.workspace_revisions;
CREATE TRIGGER trigger_workspace_revisions_immutable
    BEFORE UPDATE OR DELETE ON public.workspace_revisions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_workspace_revision_modification();

-- Indexes for speedy file history and tree navigation
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_project ON public.workspace_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_parent ON public.workspace_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_workspace_revisions_node ON public.workspace_revisions(node_id, revision_number DESC);

-- 3. ATOMIC FILE SAVE WITH OPTIMISTIC CONCURRENCY CONTROL
CREATE OR REPLACE FUNCTION save_workspace_file_atomic(
    p_file_id UUID,
    p_content TEXT,
    p_base_revision INTEGER,
    p_author_id UUID,
    p_author_name TEXT,
    p_checksum TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_node public.workspace_nodes%ROWTYPE;
    v_next_rev INTEGER;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_content_size INTEGER;
BEGIN
    -- Row-level exclusive lock prevents concurrent race conditions
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_file_id AND type = 'file' AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found or has been deleted.';
    END IF;

    -- Concurrency check: optimistic revision comparison
    IF p_base_revision IS NOT NULL AND v_node.current_revision <> p_base_revision THEN
        RETURN jsonb_build_object(
            'conflict', true,
            'currentRevision', v_node.current_revision,
            'file', to_jsonb(v_node)
        );
    END IF;

    v_next_rev := v_node.current_revision + 1;
    v_content_size := octet_length(p_content);

    -- Insert immutable revision snapshot
    INSERT INTO public.workspace_revisions (
        node_id,
        project_id,
        revision_number,
        content,
        author_id,
        author_name,
        checksum,
        created_at
    ) VALUES (
        p_file_id,
        v_node.project_id,
        v_next_rev,
        p_content,
        p_author_id,
        p_author_name,
        p_checksum,
        v_now
    );

    -- Atomically update file metadata
    UPDATE public.workspace_nodes
    SET
        current_revision = v_next_rev,
        last_modified_by = p_author_id,
        last_modified_name = p_author_name,
        updated_at = v_now,
        size = v_content_size
    WHERE id = p_file_id
    RETURNING * INTO v_node;

    RETURN jsonb_build_object(
        'conflict', false,
        'currentRevision', v_next_rev,
        'file', to_jsonb(v_node)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. ATOMIC FOLDER MOVE / RENAME WITH CYCLE PREVENTION AND PATH CASCADE
CREATE OR REPLACE FUNCTION update_workspace_node_atomic(
    p_node_id UUID,
    p_name TEXT,
    p_parent_id UUID,
    p_author_id UUID,
    p_author_name TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_node public.workspace_nodes%ROWTYPE;
    v_parent public.workspace_nodes%ROWTYPE;
    v_old_path TEXT;
    v_new_path TEXT;
    v_parent_path TEXT := '';
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_node_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace item not found.';
    END IF;

    v_old_path := v_node.path;

    -- Validate new parent if supplied
    IF p_parent_id IS NOT NULL THEN
        -- Prevent directory cycles: cannot move into self
        IF p_parent_id = p_node_id THEN
            RAISE EXCEPTION 'Cannot move a folder into itself.';
        END IF;

        SELECT * INTO v_parent
        FROM public.workspace_nodes
        WHERE id = p_parent_id AND project_id = v_node.project_id AND deleted_at IS NULL;

        IF NOT FOUND OR v_parent.type <> 'folder' THEN
            RAISE EXCEPTION 'Target parent folder not found or belongs to another project.';
        END IF;

        -- Prevent directory cycles: cannot move into descendant
        IF v_parent.path = v_old_path OR v_parent.path LIKE (v_old_path || '/%') THEN
            RAISE EXCEPTION 'Cannot move a folder into one of its descendants.';
        END IF;

        v_parent_path := v_parent.path;
    END IF;

    v_new_path := v_parent_path || '/' || p_name;

    -- Check duplicate path collision
    IF EXISTS (
        SELECT 1 FROM public.workspace_nodes
        WHERE project_id = v_node.project_id AND path = v_new_path AND id <> p_node_id AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'An item with path "%" already exists in this project.', v_new_path;
    END IF;

    -- Update target node
    UPDATE public.workspace_nodes
    SET
        name = p_name,
        parent_id = p_parent_id,
        path = v_new_path,
        last_modified_by = p_author_id,
        last_modified_name = p_author_name,
        updated_at = v_now
    WHERE id = p_node_id
    RETURNING * INTO v_node;

    -- If folder, update descendant paths consistently
    IF v_node.type = 'folder' AND v_old_path <> v_new_path THEN
        UPDATE public.workspace_nodes
        SET path = v_new_path || substring(path from length(v_old_path) + 1)
        WHERE project_id = v_node.project_id
          AND deleted_at IS NULL
          AND path LIKE (v_old_path || '/%');
    END IF;

    RETURN to_jsonb(v_node);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
