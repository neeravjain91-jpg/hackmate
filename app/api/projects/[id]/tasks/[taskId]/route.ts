import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; taskId: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { id: projectId, taskId } = params;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You are not a member of this project.' },
        { status: 403 }
      );
    }

    const task = await db.getTaskById(taskId);
    if (!task || task.project_id !== projectId) {
      return NextResponse.json({ error: 'Task not found in this project.' }, { status: 404 });
    }

    return NextResponse.json({ task });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch task.' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; taskId: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { id: projectId, taskId } = params;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You are not a member of this project.' },
        { status: 403 }
      );
    }

    const task = await db.getTaskById(taskId);
    if (!task || task.project_id !== projectId) {
      return NextResponse.json({ error: 'Task not found in this project.' }, { status: 404 });
    }

    const body = await request.json();
    const updatedTask = await db.updateTask(taskId, user.id, body);

    return NextResponse.json({ task: updatedTask });
  } catch (err: any) {
    const status = err.message?.includes('permission') || err.message?.includes('review') ? 403 : 400;
    return NextResponse.json({ error: err.message || 'Failed to update task.' }, { status });
  }
}

