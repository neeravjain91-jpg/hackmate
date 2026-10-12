import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredRateLimits } from '@/lib/auth/rateLimit';

/**
 * Scheduled Maintenance Route for Rate Limit Table Pruning.
 *
 * Deletes rate limit records whose reset_at timestamp has expired by more than 1 hour.
 * Protected against unauthenticated invocation:
 * - Requires Authorization: Bearer <CRON_SECRET> header or Vercel Cron authorization.
 * - Rejects unauthenticated callers with HTTP 401 Unauthorized.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';

  const isAuthorized = Boolean(
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (isVercelCron && (!cronSecret || authHeader === `Bearer ${cronSecret}`))
  );

  if (!isAuthorized) {
    return NextResponse.json(
      { error: 'Unauthorized: Valid maintenance authentication is required.' },
      { status: 401 }
    );
  }

  const deleted = await cleanupExpiredRateLimits();

  return NextResponse.json({
    success: true,
    deleted: deleted ?? 0,
    timestamp: new Date().toISOString(),
  });
}
