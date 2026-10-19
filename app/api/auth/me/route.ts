import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest, createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { getDatabaseAdapter, sanitizeApiError } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) return NextResponse.json({ user: null }, { status: 401 });
    const db = getDatabaseAdapter();
    if (typeof db.isUserVerified !== 'function' || !(await db.isUserVerified(user.id))) {
      const response = NextResponse.json({ user: null, error: 'Email verification status cannot be established.' }, { status: 403 });
      response.cookies.set({ name: SESSION_COOKIE_NAME, value: '', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
      return response;
    }
    const token = createSessionToken(user.id);
    const response = NextResponse.json({ user });
    response.cookies.set({ name: SESSION_COOKIE_NAME, value: token, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
    return response;
  } catch (err: any) {
    const { error, status } = sanitizeApiError(err, 'Internal error');
    return NextResponse.json({ error }, { status });
  }
}
