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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed JSON payload.' }, { status: 400 });
    }

    const { name, parent_id } = body || {};

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json({ error: 'Name must be a string.' }, { status: 400 });
      }
      const cleanName = name.trim();
      if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName.includes('/') || cleanName.includes('\\') || cleanName.includes('\0')) {
        return NextResponse.json({ error: 'Invalid name. Cannot be empty or contain path separators.' }, { status: 400 });
      }
    }

    if (parent_id !== undefined && parent_id !== null) {
      if (typeof parent_id !== 'string') {
        return NextResponse.json({ error: 'parent_id must be a string.' }, { status: 400 });
      }
      if (parent_id === nodeId) {
        return NextResponse.json({ error: 'Cannot move a folder into itself.' }, { status: 400 });
      }
      const parent = await db.getWorkspaceNode(parent_id);
      if (!parent || parent.project_id !== projectId || parent.type !== 'folder') {
        return NextResponse.json({ error: 'Target parent folder not found in this project.' }, { status: 400 });
      }
    }

    const updated = await db.updateWorkspaceNode(nodeId, { name, parent_id }, user.id, user.name);

    return NextResponse.json({ node: updated });
  } catch (err: any) {
    const isDuplicate = err.message?.includes('already exists');
    const status = isDuplicate ? 409 : 400;
    return NextResponse.json({ error: err.message || 'Failed to update item.' }, { status });
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
