import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseAdapter, sanitizeApiError } from '@/lib/db';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { checkRateLimit, getClientIp } from '@/lib/auth/rateLimit';

export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = await checkRateLimit(`register:${clientIp}`, { max: 10, windowMs: 60 * 1000 });
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': Math.ceil((rateCheck.resetAt - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    const body = await request.json();
    const { email, password, name } = body;

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Name, email, and password are required.' },
        { status: 400 }
      );
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Please provide a valid email address.' },
        { status: 400 }
      );
    }

    if (typeof password !== 'string' || password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters long.' },
        { status: 400 }
      );
    }

    const db = getDatabaseAdapter();
    const existing = await db.getUserByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email address already exists.' },
        { status: 409 }
      );
    }

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000';
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    const emailRedirectTo = `${proto}://${host}/api/auth/callback`;

    const user = await db.createUser(
      {
        email,
        name,
        password,
      },
      {
        emailRedirectTo,
      }
    );

    if (user.requiresVerification) {
      return NextResponse.json(
        {
          user,
          requiresVerification: true,
          message:
            'Registration successful. A verification email has been sent. Please verify your email address before logging in.',
        },
        { status: 201 }
      );
    }

    const token = createSessionToken(user.id);
    const response = NextResponse.json({ user, requiresVerification: false }, { status: 201 });

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
  } catch (err: any) {
    if (
      err?.message?.toLowerCase().includes('already') ||
      err?.message?.toLowerCase().includes('registered') ||
      err?.message?.toLowerCase().includes('duplicate') ||
      err?.message?.toLowerCase().includes('exists')
    ) {
      return NextResponse.json(
        { error: 'An account with this email address already exists.' },
        { status: 409 }
      );
    }
    const { error, status } = sanitizeApiError(err, 'Registration failed.');
    return NextResponse.json({ error }, { status });
  }
}
