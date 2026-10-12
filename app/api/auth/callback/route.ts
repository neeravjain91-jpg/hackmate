import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseAdapter } from '@/lib/db';
import { getSupabaseAuthClient } from '@/lib/supabase';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * Supabase Auth Email Verification Callback Route.
 *
 * Handles redirect targets for confirmation emails and magic links.
 * Exchanges PKCE codes or OTP token hashes for an authenticated Supabase session,
 * ensures the corresponding profile exists in the database, and issues a secure
 * HackMate application session cookie before redirecting to the dashboard.
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const type = requestUrl.searchParams.get('type') || 'signup';
  const errorParam = requestUrl.searchParams.get('error');
  const errorDescription = requestUrl.searchParams.get('error_description');

  const redirectBase = `${requestUrl.protocol}//${requestUrl.host}`;

  if (errorParam || errorDescription) {
    const message = encodeURIComponent(errorDescription || errorParam || 'Email verification failed.');
    return NextResponse.redirect(`${redirectBase}/login?error=verification_failed&message=${message}`);
  }

  const authClient = getSupabaseAuthClient();
  if (!authClient) {
    return NextResponse.redirect(`${redirectBase}/login?error=auth_unavailable`);
  }

  let verifiedUser: { id: string; email?: string; user_metadata?: any } | null = null;

  try {
    if (code) {
      // 1. PKCE Code Exchange Flow
      const { data, error } = await authClient.auth.exchangeCodeForSession(code);
      if (error || !data?.user) {
        throw new Error(error?.message || 'Invalid or expired verification code.');
      }
      verifiedUser = data.user;
    } else if (tokenHash) {
      // 2. Token Hash / OTP Verification Flow
      const { data, error } = await authClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as any,
      });
      if (error || !data?.user) {
        throw new Error(error?.message || 'Invalid or expired verification token.');
      }
      verifiedUser = data.user;
    } else {
      return NextResponse.redirect(`${redirectBase}/login?error=missing_verification_params`);
    }

    if (verifiedUser) {
      const db = getDatabaseAdapter();

      // Ensure profile exists in profiles table with the exact auth.users ID
      let profile = await db.getUserById(verifiedUser.id);
      if (!profile) {
        const name =
          (verifiedUser.user_metadata?.name as string) ||
          (verifiedUser.email ? verifiedUser.email.split('@')[0] : 'Student');
        const avatar_url = (verifiedUser.user_metadata?.avatar_url as string) || null;

        try {
          profile = await db.createUser({
            id: verifiedUser.id,
            email: verifiedUser.email || '',
            name,
            avatar_url,
          });
        } catch {
          // If profile creation fails, redirect to login
        }
      }

      // Create session token now that verification requirement is satisfied
      const token = createSessionToken(verifiedUser.id);
      const response = NextResponse.redirect(`${redirectBase}/dashboard?verified=true`);

      response.cookies.set({
        name: SESSION_COOKIE_NAME,
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      });

      return response;
    }

    return NextResponse.redirect(`${redirectBase}/login?verified=true`);
  } catch (err: any) {
    const message = encodeURIComponent(err.message || 'Email verification failed.');
    return NextResponse.redirect(`${redirectBase}/login?error=verification_failed&message=${message}`);
  }
}
