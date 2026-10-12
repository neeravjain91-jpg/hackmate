import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredRateLimits } from '@/lib/auth/rateLimit';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || cronSecret.trim().length === 0 || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized: valid maintenance authentication is required.' }, { status: 401 });
  }
  const deleted = await cleanupExpiredRateLimits();
  if (deleted === null) {
    return NextResponse.json({ error: 'Rate-limit cleanup is temporarily unavailable.' }, { status: 503 });
  }
  return NextResponse.json({ success: true, deleted, timestamp: new Date().toISOString() });
}
