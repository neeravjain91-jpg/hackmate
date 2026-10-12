import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolveStorageDriver, sanitizeApiError } from '@/lib/db';
import { getSupabaseAdminClient } from '@/lib/supabase';

export async function GET() {
  const startTime = Date.now();
  try {
    const driver = resolveStorageDriver();

    if (driver === 'supabase') {
      const supabaseAdmin = getSupabaseAdminClient();
      if (!supabaseAdmin) {
        return NextResponse.json(
          {
            status: 'unhealthy',
            driver,
            error: 'Supabase admin client could not be initialized.',
            timestamp: new Date().toISOString(),
          },
          { status: 503 }
        );
      }

      // Check database connectivity by querying projects table limit 1
      const { error } = await supabaseAdmin
        .from('projects')
        .select('id')
        .limit(1);

      if (error) {
        return NextResponse.json(
          {
            status: 'unhealthy',
            driver,
            error: `Database connectivity probe failed: ${error.message}`,
            timestamp: new Date().toISOString(),
          },
          { status: 503 }
        );
      }

      return NextResponse.json(
        {
          status: 'healthy',
          driver,
          database: 'connected',
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    } else {
      // Local development driver
      const dbPath = process.env.LOCAL_DB_PATH || path.join(process.cwd(), 'data', 'hackmate.json');
      const dir = path.dirname(dbPath);
      const isDirAccessible = fs.existsSync(dir);

      return NextResponse.json(
        {
          status: 'healthy',
          driver,
          storage: isDirAccessible ? 'accessible' : 'pending_init',
          latencyMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }
  } catch (err: any) {
    const { error, status } = sanitizeApiError(err, 'Health check probe failed.');
    return NextResponse.json(
      {
        status: 'unhealthy',
        error,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
      { status: status >= 400 ? status : 503 }
    );
  }
}
