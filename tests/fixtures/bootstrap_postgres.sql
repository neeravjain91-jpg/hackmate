-- ==============================================================================
-- HackMate: Disposable PostgreSQL Integration Test Fixture Bootstrap
-- ==============================================================================

-- 1. Create Supabase-compatible roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
    END IF;
END $$;

-- Allow superuser (postgres) to set role during tests
GRANT anon, authenticated, service_role TO postgres;

-- 1b. Create test_runner login role for realistic non-superuser integration tests
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_runner') THEN
        CREATE ROLE test_runner WITH LOGIN PASSWORD 'testpassword';
    END IF;
END $$;

GRANT anon, authenticated, service_role TO test_runner;

-- 2. Schemas and Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- 3. auth.users fixture
CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. auth.uid() and auth.role() implementation using controlled session settings
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(
        COALESCE(
            current_setting('request.jwt.claim.sub', true),
            current_setting('request.jwt.claim.user_id', true),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'user_id')
        ),
        ''
    )::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT AS $$
BEGIN
    RETURN NULLIF(
        COALESCE(
            current_setting('request.jwt.claim.role', true),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
        ),
        ''
    );
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;

-- 5. Base public tables: profiles, projects, project_members
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

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

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_role') THEN
        CREATE TYPE project_role AS ENUM ('leader', 'member');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role project_role NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_project_user UNIQUE (project_id, user_id)
);

-- 6. Helper functions
CREATE OR REPLACE FUNCTION public.is_project_member(_project_id UUID, _user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.project_members
        WHERE project_id = _project_id AND user_id = _user_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_project_leader(_project_id UUID, _user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.project_members
        WHERE project_id = _project_id AND user_id = _user_id AND role = 'leader'
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.is_project_member(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_leader(UUID, UUID) TO authenticated, service_role;

-- Grant permissions for test setup
GRANT ALL ON TABLE auth.users TO test_runner, postgres;
GRANT ALL ON TABLE public.profiles TO test_runner, postgres;
GRANT ALL ON TABLE public.projects TO test_runner, postgres;
GRANT ALL ON TABLE public.project_members TO test_runner, postgres;

CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members(user_id);

-- 7. Auth rate limits table & check_rate_limit function
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
    key TEXT PRIMARY KEY,
    count INT NOT NULL DEFAULT 1,
    reset_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset ON public.auth_rate_limits(reset_at);

CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_key pg_catalog.text,
    p_max pg_catalog.int4,
    p_window_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb AS $$
DECLARE
    v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
    v_count pg_catalog.int4;
    v_reset_at pg_catalog.timestamptz;
    v_allowed pg_catalog.bool;
    v_remaining pg_catalog.int4;
BEGIN
    -- Validate parameters
    IF p_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_key)) < 1 OR pg_catalog.length(p_key) > 255 THEN
        RAISE EXCEPTION 'Invalid rate limit key: must be between 1 and 255 characters';
    END IF;

    IF p_max IS NULL OR p_max < 1 OR p_max > 10000 THEN
        RAISE EXCEPTION 'Invalid rate limit max: must be between 1 and 10000';
    END IF;

    IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
        RAISE EXCEPTION 'Invalid rate limit window: must be between 1 and 86400 seconds';
    END IF;

    -- Concurrency-safe atomic UPSERT:
    -- If key does not exist: INSERT count=1 and reset_at = v_now + window
    -- If key exists and expired (reset_at < v_now): start new window count=1 and reset_at = v_now + window
    -- If key exists and active (reset_at >= v_now): increment count, keep existing reset_at
    INSERT INTO public.auth_rate_limits (key, count, reset_at)
    VALUES (p_key, 1, v_now + (p_window_seconds || ' seconds')::pg_catalog.interval)
    ON CONFLICT (key) DO UPDATE
    SET count = CASE
            WHEN public.auth_rate_limits.reset_at < v_now THEN 1
            ELSE public.auth_rate_limits.count + 1
        END,
        reset_at = CASE
            WHEN public.auth_rate_limits.reset_at < v_now THEN v_now + (p_window_seconds || ' seconds')::pg_catalog.interval
            ELSE public.auth_rate_limits.reset_at
        END
    RETURNING public.auth_rate_limits.count, public.auth_rate_limits.reset_at
    INTO v_count, v_reset_at;

    IF v_count <= p_max THEN
        v_allowed := TRUE;
        v_remaining := p_max - v_count;
    ELSE
        v_allowed := FALSE;
        v_remaining := 0;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'allowed', v_allowed,
        'remaining', v_remaining,
        'reset_at', pg_catalog.date_part('epoch', v_reset_at) * 1000
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Prune expired rate limit entries older than 1 hour
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS pg_catalog.int4 AS $$
DECLARE
    v_deleted pg_catalog.int4;
BEGIN
    DELETE FROM public.auth_rate_limits
    WHERE reset_at < pg_catalog.clock_timestamp() - '1 hour'::pg_catalog.interval;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Revoke execution from PUBLIC, anon, and authenticated
REVOKE ALL ON FUNCTION public.check_rate_limit(pg_catalog.text, pg_catalog.int4, pg_catalog.int4) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_rate_limits() FROM PUBLIC, anon, authenticated;

-- Grant execution to service_role, test_runner, postgres
GRANT EXECUTE ON FUNCTION public.check_rate_limit(pg_catalog.text, pg_catalog.int4, pg_catalog.int4) TO service_role, test_runner, postgres;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limits() TO service_role, test_runner, postgres;
GRANT ALL ON TABLE public.auth_rate_limits TO test_runner, postgres, service_role;




