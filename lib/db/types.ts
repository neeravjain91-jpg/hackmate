import {
  UserProfile,
  UserAuthRecord,
  Project,
  ProjectMember,
  ProjectRole,
  Task,
  TaskStatus,
  Contribution,
  ContributionFile,
  ProjectWithDetails,
} from '../types';

export interface IDatabaseAdapter {
  // User Management
  getUserByEmail(email: string): Promise<UserAuthRecord | null>;
  getUserById(id: string): Promise<UserProfile | null>;
  createUser(user: { email: string; name: string; password_hash?: string; avatar_url?: string | null }): Promise<UserProfile>;

  // Project Management
  createProject(data: {
    name: string;
    description: string;
    hackathon_name?: string | null;
    leader_id: string;
  }): Promise<ProjectWithDetails>;
  getProjectById(id: string): Promise<ProjectWithDetails | null>;
  getProjectByInviteCode(inviteCode: string): Promise<Project | null>;
  getUserProjects(userId: string): Promise<ProjectWithDetails[]>;
  updateProject(
    projectId: string,
    leaderId: string,
    data: { name?: string; description?: string; hackathon_name?: string | null }
  ): Promise<Project>;

  // Membership Management (Atomic Max-6 Limit)
  getProjectMembers(projectId: string): Promise<ProjectMember[]>;
  joinProject(projectId: string, userId: string, role?: ProjectRole): Promise<ProjectMember>;
  isProjectMember(projectId: string, userId: string): Promise<boolean>;
  isProjectLeader(projectId: string, userId: string): Promise<boolean>;

  // Task Management
  createTask(data: {
    project_id: string;
    title: string;
    description: string;
    assigned_to: string;
    created_by: string;
    deadline?: string | null;
  }): Promise<Task>;
  updateTask(
    taskId: string,
    actorUserId: string,
    updates: {
      title?: string;
      description?: string;
      assigned_to?: string;
      status?: TaskStatus;
      deadline?: string | null;
    }
  ): Promise<Task>;
  getProjectTasks(projectId: string): Promise<Task[]>;
  getTaskById(taskId: string): Promise<Task | null>;

  // Contribution Management
  createContribution(
    contributionData: {
      project_id: string;
      title: string;
      description: string;
      contributor_id: string;
      contributor_name: string;
      task_id?: string | null;
      version_label?: string | null;
      usage_instructions: string;
      dependencies: string;
    },
    files: Array<{
      id: string;
      file_name: string;
      file_size: number;
      mime_type: string;
      storage_path: string;
      checksum: string;
    }>
  ): Promise<Contribution>;
  getProjectContributions(
    projectId: string,
    filters?: { search?: string; contributorId?: string; taskId?: string }
  ): Promise<Contribution[]>;
  getContributionById(contributionId: string): Promise<Contribution | null>;
  getContributionFileById(fileId: string): Promise<ContributionFile | null>;

  // Common Development Workspace Management
  getWorkspaceTree(projectId: string): Promise<import('../types').WorkspaceTreeItem[]>;
  getWorkspaceNode(nodeId: string): Promise<import('../types').WorkspaceNode | null>;
  createWorkspaceNode(data: {
    project_id: string;
    parent_id?: string | null;
    name: string;
    type: import('../types').WorkspaceNodeType;
    initialContent?: string;
    author_id: string;
    author_name: string;
  }): Promise<import('../types').WorkspaceNode>;
  updateWorkspaceNode(
    nodeId: string,
    updates: { name?: string; parent_id?: string | null },
    author_id: string,
    author_name: string
  ): Promise<import('../types').WorkspaceNode>;
  deleteWorkspaceNode(nodeId: string): Promise<boolean>;
  getWorkspaceFile(fileId: string): Promise<import('../types').WorkspaceFileDetail | null>;
  saveWorkspaceFile(
    fileId: string,
    content: string,
    baseRevision: number | undefined,
    author_id: string,
    author_name: string,
    forceOverwrite?: boolean
  ): Promise<{ file: import('../types').WorkspaceFileDetail; conflict?: boolean; currentRevision?: number }>;
  getWorkspaceFileRevisions(fileId: string): Promise<import('../types').WorkspaceRevision[]>;
  restoreWorkspaceRevision(
    fileId: string,
    targetRevisionNumber: number,
    author_id: string,
    author_name: string,
    baseRevision?: number
  ): Promise<import('../types').WorkspaceFileDetail>;
}

