import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; nodeId: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { id: projectId, nodeId } = params;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    const node = await db.getWorkspaceNode(nodeId);
    if (!node || node.project_id !== projectId) {
      return NextResponse.json({ error: 'Item not found in this project.' }, { status: 404 });
    }

    const body = await request.json();
    const updated = await db.updateWorkspaceNode(nodeId, body, user.id, user.name);

    return NextResponse.json({ node: updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update item.' }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; nodeId: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { id: projectId, nodeId } = params;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    const node = await db.getWorkspaceNode(nodeId);
    if (!node || node.project_id !== projectId) {
      return NextResponse.json({ error: 'Item not found in this project.' }, { status: 404 });
    }

    const deleted = await db.deleteWorkspaceNode(nodeId);
    return NextResponse.json({ success: deleted });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete item.' }, { status: 500 });
  }
}
