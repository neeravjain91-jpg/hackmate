import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined;
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined;

    const db = getDatabaseAdapter();
    const projects = await db.getUserProjects(user.id, { limit, offset });
    return NextResponse.json({ projects });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch projects.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const body = await request.json();
    const { name, description, hackathon_name } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Project name is required.' }, { status: 400 });
    }

    const db = getDatabaseAdapter();
    const project = await db.createProject({
      name: name.trim(),
      description: (description || '').trim(),
      hackathon_name: (hackathon_name || '').trim() || null,
      leader_id: user.id,
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create project.' }, { status: 500 });
  }
}
