import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';
import { getStorageAdapter } from '@/lib/storage';

const MAX_UPLOAD_SIZE_BYTES = (parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10)) * 1024 * 1024;

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

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || undefined;
    const contributorId = searchParams.get('contributorId') || undefined;
    const taskId = searchParams.get('taskId') || undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined;
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined;

    const contributions = await db.getProjectContributions(
      projectId,
      {
        search,
        contributorId,
        taskId,
      },
      { limit, offset }
    );

    return NextResponse.json({ contributions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch contributions.' }, { status: 500 });
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

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You are not a member of this project.' },
        { status: 403 }
      );
    }

    const formData = await request.formData();

    const title = (formData.get('title') as string) || '';
    const description = (formData.get('description') as string) || '';
    const taskId = (formData.get('task_id') as string) || null;
    const versionLabel = (formData.get('version_label') as string) || null;
    const usageInstructions = (formData.get('usage_instructions') as string) || '';
    const dependencies = (formData.get('dependencies') as string) || '';

    if (!title.trim()) {
      return NextResponse.json({ error: 'Contribution title is required.' }, { status: 400 });
    }

    if (taskId) {
      const task = await db.getTaskById(taskId);
      if (!task || task.project_id !== projectId) {
        return NextResponse.json(
          { error: 'Specified task does not exist in this project.' },
          { status: 400 }
        );
      }
    }

    // Extract uploaded files
    const fileEntries = formData.getAll('files');
    const filesToUpload: File[] = [];

    for (const entry of fileEntries) {
      if (entry instanceof File && entry.size > 0) {
        filesToUpload.push(entry);
      }
    }

    if (filesToUpload.length === 0) {
      return NextResponse.json(
        { error: 'At least one file must be attached to the contribution.' },
        { status: 400 }
      );
    }

    // Validate file sizes
    for (const file of filesToUpload) {
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        return NextResponse.json(
          {
            error: `File "${file.name}" exceeds the maximum upload limit of ${
              process.env.MAX_UPLOAD_SIZE_MB || '50'
            }MB.`,
          },
          { status: 400 }
        );
      }
    }

    const storage = getStorageAdapter();
    const storedFilesMetadata = [];

    for (const file of filesToUpload) {
      const fileId = uuidv4();
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = file.type || 'application/octet-stream';

      const storedResult = await storage.saveFile(
        projectId,
        fileId,
        file.name,
        buffer,
        mimeType
      );

      storedFilesMetadata.push({
        id: fileId,
        file_name: file.name,
        file_size: storedResult.fileSize,
        mime_type: mimeType,
        storage_path: storedResult.storagePath,
        checksum: storedResult.checksum,
      });
    }

    // Persist contribution and file metadata
    const contribution = await db.createContribution(
      {
        project_id: projectId,
        title: title.trim(),
        description: description.trim(),
        contributor_id: user.id,
        contributor_name: user.name,
        task_id: taskId || null,
        version_label: versionLabel?.trim() || null,
        usage_instructions: usageInstructions.trim(),
        dependencies: dependencies.trim(),
      },
      storedFilesMetadata
    );

    return NextResponse.json({ contribution }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to publish contribution.' },
      { status: 500 }
    );
  }
}
