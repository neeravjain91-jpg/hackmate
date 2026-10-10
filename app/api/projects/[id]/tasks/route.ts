import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const projectId = params.id;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You are not a member of this project.' },
        { status: 403 }
      );
    }

    const tasks = await db.getProjectTasks(projectId);
    return NextResponse.json({ tasks });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch tasks.' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const projectId = params.id;
    const db = getDatabaseAdapter();

    // Only leader can create tasks
    const isLeader = await db.isProjectLeader(projectId, user.id);
    if (!isLeader) {
      return NextResponse.json(
        { error: 'Forbidden. Only the team leader can create and assign tasks.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { title, description, assigned_to, deadline } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'Task title is required.' }, { status: 400 });
    }

    if (!assigned_to) {
      return NextResponse.json({ error: 'Assignee is required.' }, { status: 400 });
    }

    const task = await db.createTask({
      project_id: projectId,
      title: title.trim(),
      description: (description || '').trim(),
      assigned_to,
      created_by: user.id,
      deadline: deadline || null,
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create task.' }, { status: 500 });
  }
}
