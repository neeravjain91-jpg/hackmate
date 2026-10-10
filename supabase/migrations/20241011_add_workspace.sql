-- ==============================================================================
-- HACKMATE: Common Development Workspace Migration
-- Migration: 20241011_add_workspace.sql
-- ==============================================================================

-- 0. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

-- Prevent changing project_id of existing workspace nodes
CREATE OR REPLACE FUNCTION public.prevent_workspace_node_project_transfer()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.project_id <> OLD.project_id THEN
        RAISE EXCEPTION 'Forbidden: Transferring workspace nodes across projects is prohibited.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prevent_workspace_node_project_transfer ON public.workspace_nodes;
CREATE TRIGGER trigger_prevent_workspace_node_project_transfer
    BEFORE UPDATE OF project_id ON public.workspace_nodes
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_workspace_node_project_transfer();

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
    WITH CHECK (
        is_project_member(project_id, auth.uid()) AND
        last_modified_by = auth.uid()
    );

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
CREATE OR REPLACE FUNCTION public.prevent_workspace_revision_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Workspace revisions are immutable historical records and cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_workspace_revisions_immutable ON public.workspace_revisions;
CREATE TRIGGER trigger_workspace_revisions_immutable
    BEFORE UPDATE OR DELETE ON public.workspace_revisions
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_workspace_revision_modification();

-- Indexes for speedy file history and tree navigation
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_project ON public.workspace_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_parent ON public.workspace_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_workspace_revisions_node ON public.workspace_revisions(node_id, revision_number DESC);

-- 3. ATOMIC FILE CREATION (Single Transaction for Node + Revision 1)
CREATE OR REPLACE FUNCTION public.create_workspace_node_atomic(
    p_project_id UUID,
    p_parent_id UUID,
    p_name TEXT,
    p_type workspace_node_type,
    p_initial_content TEXT,
    p_author_id UUID DEFAULT NULL,
    p_author_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_author_name TEXT;
    v_parent public.workspace_nodes%ROWTYPE;
    v_parent_path TEXT := '';
    v_node_path TEXT;
    v_new_node public.workspace_nodes%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_size INTEGER;
    v_checksum TEXT;
    v_clean_name TEXT;
BEGIN
    -- Authenticate caller
    IF v_caller_id IS NULL THEN
        IF current_user = 'service_role' OR current_user = 'postgres' THEN
            v_caller_id := p_author_id;
        END IF;
    END IF;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    -- Prevent contributor impersonation
    IF p_author_id IS NOT NULL AND p_author_id <> v_caller_id THEN
        RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
    END IF;

    -- Resolve author name from profiles if available
    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := COALESCE(p_author_name, 'Anonymous');
    END IF;

    -- Verify project membership
    IF NOT is_project_member(p_project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    v_clean_name := trim(p_name);
    IF v_clean_name = '' OR v_clean_name = '.' OR v_clean_name = '..' OR v_clean_name LIKE '%/%' OR v_clean_name LIKE '%\%' OR position(E'\0' in v_clean_name) > 0 THEN
        RAISE EXCEPTION 'Invalid file or folder name. Name cannot be empty or contain path separators.';
    END IF;

    -- Validate parent if supplied
    IF p_parent_id IS NOT NULL THEN
        SELECT * INTO v_parent
        FROM public.workspace_nodes
        WHERE id = p_parent_id AND project_id = p_project_id AND deleted_at IS NULL;

        IF NOT FOUND OR v_parent.type <> 'folder' THEN
            RAISE EXCEPTION 'Parent folder not found, belongs to another project, or is not a folder.';
        END IF;

        v_parent_path := v_parent.path;
    END IF;

    v_node_path := v_parent_path || '/' || v_clean_name;

    -- Check duplicate active path
    IF EXISTS (
        SELECT 1 FROM public.workspace_nodes
        WHERE project_id = p_project_id AND path = v_node_path AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'An item with path "%" already exists in this project.', v_node_path;
    END IF;

    IF p_type = 'file' THEN
        v_size := octet_length(COALESCE(p_initial_content, ''));
        IF v_size > 10 * 1024 * 1024 THEN
            RAISE EXCEPTION 'File content exceeds the maximum size limit of 10MB.';
        END IF;
    END IF;

    -- 1. Insert file node
    INSERT INTO public.workspace_nodes (
        project_id,
        parent_id,
        name,
        path,
        type,
        current_revision,
        last_modified_by,
        last_modified_name,
        size,
        created_at,
        updated_at
    ) VALUES (
        p_project_id,
        p_parent_id,
        v_clean_name,
        v_node_path,
        p_type,
        1,
        v_caller_id,
        v_author_name,
        v_size,
        v_now,
        v_now
    ) RETURNING * INTO v_new_node;

    -- 2. If file, insert initial revision atomically in the SAME transaction
    IF p_type = 'file' THEN
        v_checksum := encode(digest(COALESCE(p_initial_content, ''), 'sha256'), 'hex');

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
            v_new_node.id,
            p_project_id,
            1,
            COALESCE(p_initial_content, ''),
            v_caller_id,
            v_author_name,
            v_checksum,
            v_now
        );
    END IF;

    RETURN to_jsonb(v_new_node);
END;
$$;

-- 4. ATOMIC FILE SAVE WITH OPTIMISTIC CONCURRENCY CONTROL & AUTH VERIFICATION
CREATE OR REPLACE FUNCTION public.save_workspace_file_atomic(
    p_file_id UUID,
    p_content TEXT,
    p_base_revision INTEGER,
    p_author_id UUID DEFAULT NULL,
    p_author_name TEXT DEFAULT NULL,
    p_checksum TEXT DEFAULT NULL,
    p_project_id UUID DEFAULT NULL,
    p_force_overwrite BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_author_name TEXT;
    v_node public.workspace_nodes%ROWTYPE;
    v_next_rev INTEGER;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_content_size INTEGER;
    v_checksum TEXT := p_checksum;
BEGIN
    -- Authenticate caller
    IF v_caller_id IS NULL THEN
        IF current_user = 'service_role' OR current_user = 'postgres' THEN
            v_caller_id := p_author_id;
        END IF;
    END IF;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    -- Prevent contributor impersonation
    IF p_author_id IS NOT NULL AND p_author_id <> v_caller_id THEN
        RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
    END IF;

    -- Resolve author name from profiles if available
    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := COALESCE(p_author_name, 'Anonymous');
    END IF;

    -- Row-level exclusive lock prevents concurrent race conditions
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_file_id AND type = 'file' AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found or has been deleted.';
    END IF;

    -- Verify caller is an authorized member of this project
    IF NOT is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    -- Verify target file belongs to requested project if supplied
    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: File does not belong to the specified project.';
    END IF;

    -- Concurrency check: baseRevision cannot be omitted unless force_overwrite is explicitly granted
    IF p_base_revision IS NULL AND (p_force_overwrite IS NOT TRUE) THEN
        RAISE EXCEPTION 'Concurrency check required: baseRevision must be specified for workspace saves.';
    END IF;

    IF p_base_revision IS NOT NULL AND v_node.current_revision <> p_base_revision THEN
        RETURN jsonb_build_object(
            'conflict', true,
            'currentRevision', v_node.current_revision,
            'file', to_jsonb(v_node)
        );
    END IF;

    v_content_size := octet_length(COALESCE(p_content, ''));
    IF v_content_size > 10 * 1024 * 1024 THEN
        RAISE EXCEPTION 'File content exceeds the maximum size limit of 10MB.';
    END IF;

    IF v_checksum IS NULL OR v_checksum = '' THEN
        v_checksum := encode(digest(COALESCE(p_content, ''), 'sha256'), 'hex');
    END IF;

    v_next_rev := v_node.current_revision + 1;

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
        COALESCE(p_content, ''),
        v_caller_id,
        v_author_name,
        v_checksum,
        v_now
    );

    -- Atomically update file metadata
    UPDATE public.workspace_nodes
    SET
        current_revision = v_next_rev,
        last_modified_by = v_caller_id,
        last_modified_name = v_author_name,
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
$$;

-- 5. ATOMIC FOLDER MOVE / RENAME WITH CYCLE PREVENTION AND PATH CASCADE
CREATE OR REPLACE FUNCTION public.update_workspace_node_atomic(
    p_node_id UUID,
    p_name TEXT,
    p_parent_id UUID,
    p_author_id UUID DEFAULT NULL,
    p_author_name TEXT DEFAULT NULL,
    p_project_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_author_name TEXT;
    v_node public.workspace_nodes%ROWTYPE;
    v_parent public.workspace_nodes%ROWTYPE;
    v_old_path TEXT;
    v_new_path TEXT;
    v_parent_path TEXT := '';
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_clean_name TEXT;
    v_curr_parent UUID;
BEGIN
    IF v_caller_id IS NULL THEN
        IF current_user = 'service_role' OR current_user = 'postgres' THEN
            v_caller_id := p_author_id;
        END IF;
    END IF;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    IF p_author_id IS NOT NULL AND p_author_id <> v_caller_id THEN
        RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
    END IF;

    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := COALESCE(p_author_name, 'Anonymous');
    END IF;

    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_node_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace item not found.';
    END IF;

    IF NOT is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: Node does not belong to specified project.';
    END IF;

    v_old_path := v_node.path;
    v_clean_name := COALESCE(trim(p_name), v_node.name);

    IF v_clean_name = '' OR v_clean_name = '.' OR v_clean_name = '..' OR v_clean_name LIKE '%/%' OR v_clean_name LIKE '%\%' OR position(E'\0' in v_clean_name) > 0 THEN
        RAISE EXCEPTION 'Invalid file or folder name. Name cannot be empty or contain path separators.';
    END IF;

    -- Validate new parent if supplied
    IF p_parent_id IS NOT NULL THEN
        IF p_parent_id = p_node_id THEN
            RAISE EXCEPTION 'Cannot move a folder into itself.';
        END IF;

        SELECT * INTO v_parent
        FROM public.workspace_nodes
        WHERE id = p_parent_id AND project_id = v_node.project_id AND deleted_at IS NULL;

        IF NOT FOUND OR v_parent.type <> 'folder' THEN
            RAISE EXCEPTION 'Target parent folder not found or belongs to another project.';
        END IF;

        IF v_node.type = 'folder' THEN
            IF v_parent.path = v_old_path OR v_parent.path LIKE (v_old_path || '/%') THEN
                RAISE EXCEPTION 'Cannot move a folder into one of its descendants.';
            END IF;

            v_curr_parent := v_parent.parent_id;
            WHILE v_curr_parent IS NOT NULL LOOP
                IF v_curr_parent = p_node_id THEN
                    RAISE EXCEPTION 'Cannot move a folder into one of its descendants.';
                END IF;
                SELECT parent_id INTO v_curr_parent FROM public.workspace_nodes WHERE id = v_curr_parent AND deleted_at IS NULL;
            END LOOP;
        END IF;

        v_parent_path := v_parent.path;
    END IF;

    v_new_path := v_parent_path || '/' || v_clean_name;

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
        name = v_clean_name,
        parent_id = p_parent_id,
        path = v_new_path,
        last_modified_by = v_caller_id,
        last_modified_name = v_author_name,
        updated_at = v_now
    WHERE id = p_node_id
    RETURNING * INTO v_node;

    -- If folder, update descendant paths consistently
    IF v_node.type = 'folder' AND v_old_path <> v_new_path THEN
        UPDATE public.workspace_nodes
        SET path = v_new_path || substring(path from length(v_old_path) + 1),
            updated_at = v_now
        WHERE project_id = v_node.project_id
          AND deleted_at IS NULL
          AND path LIKE (v_old_path || '/%');
    END IF;

    RETURN to_jsonb(v_node);
END;
$$;

-- 6. ATOMIC FOLDER & FILE DELETION (Soft-deletes target & all descendants in one transaction)
CREATE OR REPLACE FUNCTION public.delete_workspace_node_atomic(
    p_node_id UUID,
    p_project_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_node public.workspace_nodes%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_node_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false);
    END IF;

    IF v_caller_id IS NULL THEN
        IF current_user = 'service_role' OR current_user = 'postgres' THEN
            v_caller_id := v_node.last_modified_by;
        ELSE
            RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
        END IF;
    END IF;

    IF NOT is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: Node does not belong to specified project.';
    END IF;

    -- Soft delete target node
    UPDATE public.workspace_nodes
    SET deleted_at = v_now
    WHERE id = p_node_id;

    -- If folder, soft delete all descendants in the same transaction
    IF v_node.type = 'folder' THEN
        UPDATE public.workspace_nodes
        SET deleted_at = v_now
        WHERE project_id = v_node.project_id
          AND deleted_at IS NULL
          AND path LIKE (v_node.path || '/%');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- 7. EXPLICIT PRIVILEGE RESTRICTIONS (Principle of Least Privilege)
REVOKE ALL ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, workspace_node_type, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, workspace_node_type, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, workspace_node_type, TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID) TO service_role;
