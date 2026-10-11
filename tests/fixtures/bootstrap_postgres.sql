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

