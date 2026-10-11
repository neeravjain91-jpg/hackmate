-- Migration: 20241012_harden_workspace_security_and_rpc.sql
-- Description: Corrective migration resolving review blockers:
--  1. Drop all obsolete and ambiguous RPC function overloads.
--  2. Harden SECURITY DEFINER functions with SET search_path = '' and fully qualified schemas.
--  3. Implement trustworthy caller authentication distinguishing user JWT vs service-role execution without relying on current_user or schema-qualifying SESSION_USER.
--  4. Implement authoritative checksum computation and integrity verification inside the database.
--  5. Implement wildcard-safe subtree traversal via recursive CTEs instead of SQL LIKE patterns.
--  6. Enforce strict database boundary protections against direct table mutations.

-- 1. DROP OBSOLETE & AMBIGUOUS FUNCTION OVERLOADS
DROP FUNCTION IF EXISTS public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.delete_workspace_node_atomic(UUID, UUID);
DROP FUNCTION IF EXISTS public.delete_workspace_node_atomic(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.create_workspace_node_atomic(UUID, UUID, TEXT, workspace_node_type, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.create_workspace_node_atomic(UUID, UUID, TEXT, public.workspace_node_type, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.create_workspace_node_atomic(UUID, UUID, TEXT, public.workspace_node_type, TEXT, UUID, TEXT, TEXT);

-- 2. HARDEN DIRECT TABLE PERMISSIONS (Enforce mutations solely via RPCs)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_nodes FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.workspace_nodes TO authenticated, service_role;
GRANT SELECT ON TABLE public.workspace_revisions TO authenticated, service_role;

DROP POLICY IF EXISTS "Members can create workspace nodes" ON public.workspace_nodes;
DROP POLICY IF EXISTS "Members can update workspace nodes" ON public.workspace_nodes;
DROP POLICY IF EXISTS "Members can delete workspace nodes" ON public.workspace_nodes;
DROP POLICY IF EXISTS "Leaders can hard delete workspace nodes" ON public.workspace_nodes;
DROP POLICY IF EXISTS "Members can insert workspace revisions" ON public.workspace_revisions;

-- 3. SCHEMA-AGNOSTIC CRYPTOGRAPHIC HASH RESOLUTION HELPER
CREATE OR REPLACE FUNCTION public.workspace_calculate_checksum(p_content TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_digest BYTEA;
BEGIN
    -- Check 'extensions' schema (standard Supabase managed setup)
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'extensions' AND p.proname = 'digest'
    ) THEN
        EXECUTE 'SELECT extensions.digest(pg_catalog.convert_to(pg_catalog.coalesce($1, ''''), ''UTF8''), ''sha256'')'
        INTO v_digest USING p_content;
        RETURN pg_catalog.encode(v_digest, 'hex');
    -- Check 'public' schema (local/custom PostgreSQL setup)
    ELSIF EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'digest'
    ) THEN
        EXECUTE 'SELECT public.digest(pg_catalog.convert_to(pg_catalog.coalesce($1, ''''), ''UTF8''), ''sha256'')'
        INTO v_digest USING p_content;
        RETURN pg_catalog.encode(v_digest, 'hex');
    ELSE
        -- Fallback to pg_catalog.sha256 if available in PostgreSQL 14+
        BEGIN
            EXECUTE 'SELECT pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.coalesce($1, ''''), ''UTF8''))'
            INTO v_digest USING p_content;
            RETURN pg_catalog.encode(v_digest, 'hex');
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Cryptographic hash provider (pgcrypto) not found in extensions or public schema.';
        END;
    END IF;
END;
$$;

-- 4. ATOMIC FILE & FOLDER CREATION (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION public.create_workspace_node_atomic(
    p_project_id UUID,
    p_parent_id UUID,
    p_name TEXT,
    p_type public.workspace_node_type,
    p_initial_content TEXT,
    p_author_id UUID DEFAULT NULL,
    p_author_name TEXT DEFAULT NULL,
    p_checksum TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID;
    v_jwt_role TEXT;
    v_is_service_role BOOLEAN := FALSE;
    v_caller_id UUID;
    v_author_name TEXT;
    v_parent public.workspace_nodes%ROWTYPE;
    v_parent_path TEXT := '';
    v_node_path TEXT;
    v_new_node public.workspace_nodes%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc'::text, pg_catalog.now());
    v_size INTEGER := 0;
    v_computed_checksum TEXT;
    v_checksum TEXT;
    v_clean_name TEXT;
BEGIN
    -- Resolve trustworthy auth context
    BEGIN
        v_auth_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_auth_uid := NULL;
    END;

    BEGIN
        v_jwt_role := pg_catalog.coalesce(
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        );
    EXCEPTION WHEN OTHERS THEN
        v_jwt_role := NULL;
    END;

    IF v_jwt_role = 'service_role' OR SESSION_USER IN ('service_role', 'postgres') THEN
        v_is_service_role := TRUE;
    END IF;

    IF v_auth_uid IS NOT NULL THEN
        IF p_author_id IS NOT NULL AND p_author_id <> v_auth_uid THEN
            RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
        END IF;
        v_caller_id := v_auth_uid;
    ELSIF v_is_service_role THEN
        IF p_author_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Author ID is required for service-role workspace operations.';
        END IF;
        v_caller_id := p_author_id;
    ELSE
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    -- Lookup author name from profiles if available
    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := pg_catalog.coalesce(p_author_name, 'Anonymous');
    END IF;

    -- Verify project membership
    IF NOT public.is_project_member(p_project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    v_clean_name := pg_catalog.trim(p_name);
    IF v_clean_name = '' OR v_clean_name = '.' OR v_clean_name = '..' OR
       pg_catalog.position('/' in v_clean_name) > 0 OR
       pg_catalog.position('\' in v_clean_name) > 0 OR
       pg_catalog.position(E'\0' in v_clean_name) > 0 THEN
        RAISE EXCEPTION 'Invalid file or folder name. Name cannot be empty or contain path separators.';
    END IF;

    -- Validate parent folder if specified
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
        v_size := pg_catalog.octet_length(pg_catalog.coalesce(p_initial_content, ''));
        IF v_size > 10 * 1024 * 1024 THEN
            RAISE EXCEPTION 'File content exceeds the maximum size limit of 10MB.';
        END IF;

        -- Authoritative checksum computation and integrity verification
        v_computed_checksum := public.workspace_calculate_checksum(pg_catalog.coalesce(p_initial_content, ''));
        IF p_checksum IS NOT NULL AND pg_catalog.trim(p_checksum) <> '' THEN
            IF pg_catalog.lower(pg_catalog.trim(p_checksum)) <> v_computed_checksum THEN
                RAISE EXCEPTION 'Checksum mismatch: Supplied checksum does not match computed content hash.';
            END IF;
        END IF;
        v_checksum := v_computed_checksum;
    ELSE
        v_size := 0;
        v_checksum := NULL;
    END IF;

    -- 1. Insert workspace node
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
        CASE WHEN p_type = 'file' THEN 1 ELSE 0 END,
        v_caller_id,
        v_author_name,
        v_size,
        v_now,
        v_now
    ) RETURNING * INTO v_new_node;

    -- 2. If file, insert initial revision atomically in the same transaction
    IF p_type = 'file' THEN
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
            pg_catalog.coalesce(p_initial_content, ''),
            v_caller_id,
            v_author_name,
            v_checksum,
            v_now
        );
    END IF;

    RETURN pg_catalog.to_jsonb(v_new_node);
END;
$$;

-- 5. ATOMIC FILE SAVE WITH OPTIMISTIC CONCURRENCY CONTROL (SECURITY DEFINER, search_path = '')
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
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID;
    v_jwt_role TEXT;
    v_is_service_role BOOLEAN := FALSE;
    v_caller_id UUID;
    v_author_name TEXT;
    v_node public.workspace_nodes%ROWTYPE;
    v_next_rev INTEGER;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc'::text, pg_catalog.now());
    v_content_size INTEGER;
    v_computed_checksum TEXT;
    v_checksum TEXT;
BEGIN
    -- Resolve trustworthy auth context
    BEGIN
        v_auth_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_auth_uid := NULL;
    END;

    BEGIN
        v_jwt_role := pg_catalog.coalesce(
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        );
    EXCEPTION WHEN OTHERS THEN
        v_jwt_role := NULL;
    END;

    IF v_jwt_role = 'service_role' OR SESSION_USER IN ('service_role', 'postgres') THEN
        v_is_service_role := TRUE;
    END IF;

    IF v_auth_uid IS NOT NULL THEN
        IF p_author_id IS NOT NULL AND p_author_id <> v_auth_uid THEN
            RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
        END IF;
        v_caller_id := v_auth_uid;
    ELSIF v_is_service_role THEN
        IF p_author_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Author ID is required for service-role workspace operations.';
        END IF;
        v_caller_id := p_author_id;
    ELSE
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    -- Lookup author name from profiles if available
    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := pg_catalog.coalesce(p_author_name, 'Anonymous');
    END IF;

    -- Row-level exclusive lock on file
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_file_id AND type = 'file' AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found or has been deleted.';
    END IF;

    -- Verify caller is an authorized member of this project
    IF NOT public.is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    -- Verify project isolation
    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: File does not belong to the specified project.';
    END IF;

    -- Concurrency check: baseRevision cannot be omitted unless force_overwrite is explicitly TRUE
    IF p_base_revision IS NULL AND (p_force_overwrite IS NOT TRUE) THEN
        RAISE EXCEPTION 'Concurrency check required: baseRevision must be specified for workspace saves.';
    END IF;

    IF (p_force_overwrite IS NOT TRUE) AND p_base_revision IS NOT NULL AND v_node.current_revision <> p_base_revision THEN
        RETURN pg_catalog.jsonb_build_object(
            'conflict', true,
            'currentRevision', v_node.current_revision,
            'file', pg_catalog.to_jsonb(v_node)
        );
    END IF;

    v_content_size := pg_catalog.octet_length(pg_catalog.coalesce(p_content, ''));
    IF v_content_size > 10 * 1024 * 1024 THEN
        RAISE EXCEPTION 'File content exceeds the maximum size limit of 10MB.';
    END IF;

    -- Authoritative checksum computation and integrity verification
    v_computed_checksum := public.workspace_calculate_checksum(pg_catalog.coalesce(p_content, ''));
    IF p_checksum IS NOT NULL AND pg_catalog.trim(p_checksum) <> '' THEN
        IF pg_catalog.lower(pg_catalog.trim(p_checksum)) <> v_computed_checksum THEN
            RAISE EXCEPTION 'Checksum mismatch: Supplied checksum does not match computed content hash.';
        END IF;
    END IF;
    v_checksum := v_computed_checksum;

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
        pg_catalog.coalesce(p_content, ''),
        v_caller_id,
        v_author_name,
        v_checksum,
        v_now
    );

    -- Update node metadata
    UPDATE public.workspace_nodes
    SET
        current_revision = v_next_rev,
        last_modified_by = v_caller_id,
        last_modified_name = v_author_name,
        updated_at = v_now,
        size = v_content_size
    WHERE id = p_file_id
    RETURNING * INTO v_node;

    RETURN pg_catalog.jsonb_build_object(
        'conflict', false,
        'currentRevision', v_next_rev,
        'file', pg_catalog.to_jsonb(v_node)
    );
END;
$$;

-- 6. ATOMIC FOLDER MOVE / RENAME WITH WILDCARD-SAFE RECURSIVE TRAVERSAL (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION public.update_workspace_node_atomic(
    p_node_id UUID,
    p_name TEXT DEFAULT NULL,
    p_parent_id UUID DEFAULT NULL,
    p_author_id UUID DEFAULT NULL,
    p_author_name TEXT DEFAULT NULL,
    p_project_id UUID DEFAULT NULL,
    p_update_parent BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID;
    v_jwt_role TEXT;
    v_is_service_role BOOLEAN := FALSE;
    v_caller_id UUID;
    v_author_name TEXT;
    v_node public.workspace_nodes%ROWTYPE;
    v_parent public.workspace_nodes%ROWTYPE;
    v_old_path TEXT;
    v_new_path TEXT;
    v_new_parent_id UUID;
    v_parent_path TEXT := '';
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc'::text, pg_catalog.now());
    v_clean_name TEXT;
    v_curr_parent UUID;
BEGIN
    -- Resolve trustworthy auth context
    BEGIN
        v_auth_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_auth_uid := NULL;
    END;

    BEGIN
        v_jwt_role := pg_catalog.coalesce(
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        );
    EXCEPTION WHEN OTHERS THEN
        v_jwt_role := NULL;
    END;

    IF v_jwt_role = 'service_role' OR SESSION_USER IN ('service_role', 'postgres') THEN
        v_is_service_role := TRUE;
    END IF;

    IF v_auth_uid IS NOT NULL THEN
        IF p_author_id IS NOT NULL AND p_author_id <> v_auth_uid THEN
            RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
        END IF;
        v_caller_id := v_auth_uid;
    ELSIF v_is_service_role THEN
        IF p_author_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Author ID is required for service-role workspace operations.';
        END IF;
        v_caller_id := p_author_id;
    ELSE
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    -- Lookup author name from profiles if available
    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := pg_catalog.coalesce(p_author_name, 'Anonymous');
    END IF;

    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_node_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace item not found.';
    END IF;

    IF NOT public.is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: Node does not belong to specified project.';
    END IF;

    v_old_path := v_node.path;
    v_clean_name := pg_catalog.coalesce(pg_catalog.trim(p_name), v_node.name);

    IF v_clean_name = '' OR v_clean_name = '.' OR v_clean_name = '..' OR
       pg_catalog.position('/' in v_clean_name) > 0 OR
       pg_catalog.position('\' in v_clean_name) > 0 OR
       pg_catalog.position(E'\0' in v_clean_name) > 0 THEN
        RAISE EXCEPTION 'Invalid file or folder name. Name cannot be empty or contain path separators.';
    END IF;

    -- Handle parent updates vs preserving existing parent
    IF p_update_parent IS TRUE THEN
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

            -- Prevent directory cycles strictly by checking ancestor tree hierarchy (no LIKE)
            IF v_node.type = 'folder' THEN
                v_curr_parent := v_parent.id;
                WHILE v_curr_parent IS NOT NULL LOOP
                    IF v_curr_parent = p_node_id THEN
                        RAISE EXCEPTION 'Cannot move a folder into one of its descendants.';
                    END IF;
                    SELECT parent_id INTO v_curr_parent
                    FROM public.workspace_nodes
                    WHERE id = v_curr_parent AND deleted_at IS NULL;
                END LOOP;
            END IF;

            v_new_parent_id := p_parent_id;
            v_parent_path := v_parent.path;
        ELSE
            -- Explicit move to project root
            v_new_parent_id := NULL;
            v_parent_path := '';
        END IF;
    ELSE
        -- Preserve existing parent
        v_new_parent_id := v_node.parent_id;
        IF v_node.parent_id IS NOT NULL THEN
            SELECT * INTO v_parent
            FROM public.workspace_nodes
            WHERE id = v_node.parent_id AND project_id = v_node.project_id AND deleted_at IS NULL;

            IF FOUND THEN
                v_parent_path := v_parent.path;
            ELSE
                v_parent_path := '';
            END IF;
        ELSE
            v_parent_path := '';
        END IF;
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
        parent_id = v_new_parent_id,
        path = v_new_path,
        last_modified_by = v_caller_id,
        last_modified_name = v_author_name,
        updated_at = v_now
    WHERE id = p_node_id
    RETURNING * INTO v_node;

    -- If folder, update descendant paths using WILDCARD-SAFE RECURSIVE CTE (no LIKE patterns)
    IF v_node.type = 'folder' AND v_old_path <> v_new_path THEN
        WITH RECURSIVE descendants AS (
            SELECT id, 1 AS depth
            FROM public.workspace_nodes
            WHERE parent_id = p_node_id
              AND project_id = v_node.project_id
              AND deleted_at IS NULL
            UNION ALL
            SELECT c.id, d.depth + 1
            FROM public.workspace_nodes c
            JOIN descendants d ON c.parent_id = d.id
            WHERE c.project_id = v_node.project_id
              AND c.deleted_at IS NULL
        )
        UPDATE public.workspace_nodes
        SET path = v_new_path || pg_catalog.substring(path from (pg_catalog.length(v_old_path) + 1)),
            updated_at = v_now
        WHERE id IN (SELECT id FROM descendants);
    END IF;

    RETURN pg_catalog.to_jsonb(v_node);
END;
$$;

-- 7. ATOMIC FOLDER & FILE DELETION WITH WILDCARD-SAFE RECURSIVE TRAVERSAL (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION public.delete_workspace_node_atomic(
    p_node_id UUID,
    p_author_id UUID DEFAULT NULL,
    p_project_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID;
    v_jwt_role TEXT;
    v_is_service_role BOOLEAN := FALSE;
    v_caller_id UUID;
    v_author_name TEXT;
    v_node public.workspace_nodes%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc'::text, pg_catalog.now());
BEGIN
    SELECT * INTO v_node
    FROM public.workspace_nodes
    WHERE id = p_node_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('success', false);
    END IF;

    -- Resolve trustworthy auth context
    BEGIN
        v_auth_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_auth_uid := NULL;
    END;

    BEGIN
        v_jwt_role := pg_catalog.coalesce(
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
            pg_catalog.nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        );
    EXCEPTION WHEN OTHERS THEN
        v_jwt_role := NULL;
    END;

    IF v_jwt_role = 'service_role' OR SESSION_USER IN ('service_role', 'postgres') THEN
        v_is_service_role := TRUE;
    END IF;

    IF v_auth_uid IS NOT NULL THEN
        IF p_author_id IS NOT NULL AND p_author_id <> v_auth_uid THEN
            RAISE EXCEPTION 'Forbidden: Impersonation of other contributors is not permitted.';
        END IF;
        v_caller_id := v_auth_uid;
    ELSIF v_is_service_role THEN
        v_caller_id := pg_catalog.coalesce(p_author_id, v_node.last_modified_by);
    ELSE
        RAISE EXCEPTION 'Unauthorized: Authenticated user required.';
    END IF;

    SELECT name INTO v_author_name FROM public.profiles WHERE id = v_caller_id;
    IF v_author_name IS NULL OR v_author_name = '' THEN
        v_author_name := 'Anonymous';
    END IF;

    IF NOT public.is_project_member(v_node.project_id, v_caller_id) THEN
        RAISE EXCEPTION 'Forbidden: You are not an authorized member of this project.';
    END IF;

    IF p_project_id IS NOT NULL AND v_node.project_id <> p_project_id THEN
        RAISE EXCEPTION 'Forbidden: Node does not belong to specified project.';
    END IF;

    -- Soft delete target node
    UPDATE public.workspace_nodes
    SET deleted_at = v_now,
        last_modified_by = v_caller_id,
        last_modified_name = v_author_name,
        updated_at = v_now
    WHERE id = p_node_id;

    -- If folder, soft delete all descendants using WILDCARD-SAFE RECURSIVE CTE (no LIKE patterns)
    IF v_node.type = 'folder' THEN
        WITH RECURSIVE descendants AS (
            SELECT id
            FROM public.workspace_nodes
            WHERE parent_id = p_node_id
              AND project_id = v_node.project_id
              AND deleted_at IS NULL
            UNION ALL
            SELECT c.id
            FROM public.workspace_nodes c
            JOIN descendants d ON c.parent_id = d.id
            WHERE c.project_id = v_node.project_id
              AND c.deleted_at IS NULL
        )
        UPDATE public.workspace_nodes
        SET deleted_at = v_now,
            last_modified_by = v_caller_id,
            last_modified_name = v_author_name,
            updated_at = v_now
        WHERE id IN (SELECT id FROM descendants);
    END IF;

    RETURN pg_catalog.jsonb_build_object('success', true);
END;
$$;

-- 8. EXPLICIT PRIVILEGE RESTRICTIONS
REVOKE ALL ON FUNCTION public.workspace_calculate_checksum(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workspace_calculate_checksum(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.workspace_calculate_checksum(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, public.workspace_node_type, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, public.workspace_node_type, TEXT, UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_node_atomic(UUID, UUID, TEXT, public.workspace_node_type, TEXT, UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_workspace_node_atomic(UUID, UUID, UUID) TO authenticated, service_role;
