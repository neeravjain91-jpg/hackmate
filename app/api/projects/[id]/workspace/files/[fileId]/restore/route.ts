import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; fileId: string } }
) {
  const { id: projectId, fileId } = params;
  const db = getDatabaseAdapter();

  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    const file = await db.getWorkspaceFile(fileId);
    if (!file || file.project_id !== projectId) {
      return NextResponse.json({ error: 'File not found in this project.' }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed JSON payload.' }, { status: 400 });
    }

    const { revisionNumber, baseRevision, forceOverwrite } = body || {};

    if (
      revisionNumber === undefined ||
      typeof revisionNumber !== 'number' ||
      !Number.isInteger(revisionNumber) ||
      revisionNumber < 1
    ) {
      return NextResponse.json(
        { error: 'Valid positive integer revisionNumber is required.' },
        { status: 400 }
      );
    }

    // Validate forceOverwrite strictly as boolean if provided
    if (forceOverwrite !== undefined && typeof forceOverwrite !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid forceOverwrite parameter. Must be a boolean (true or false).' },
        { status: 400 }
      );
    }

    const isForce = forceOverwrite === true;

    if (!isForce) {
      if (
        baseRevision === undefined ||
        typeof baseRevision !== 'number' ||
        !Number.isInteger(baseRevision) ||
        baseRevision < 1
      ) {
        return NextResponse.json(
          { error: 'Concurrency check required: Valid positive integer baseRevision is required for workspace restoration.' },
          { status: 400 }
        );
      }
    } else if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1)
    ) {
      return NextResponse.json(
        { error: 'Valid positive integer baseRevision is required.' },
        { status: 400 }
      );
    }

    const restoredFile = await db.restoreWorkspaceRevision(
      fileId,
      revisionNumber,
      user.id,
      user.name,
      baseRevision,
      isForce
    );

    return NextResponse.json({ file: restoredFile });
  } catch (err: any) {
    const isConflict = err.message?.includes('Conflict');
    const status = isConflict ? 409 : 400;
    let currentRevision: number | undefined;
    if (isConflict) {
      try {
        const currentFile = await db.getWorkspaceFile(fileId);
        currentRevision = currentFile?.current_revision;
      } catch {
        // ignore
      }
    }
    return NextResponse.json(
      {
        error: err.message || 'Failed to restore revision.',
        conflict: isConflict,
        ...(currentRevision !== undefined ? { currentRevision } : {}),
      },
      { status }
    );
  }
}
