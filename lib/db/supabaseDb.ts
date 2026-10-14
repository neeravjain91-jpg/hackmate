import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
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
  WorkspaceNode,
  WorkspaceNodeType,
  WorkspaceRevision,
  WorkspaceFileDetail,
  WorkspaceTreeItem,
} from '../types';
import { IDatabaseAdapter, PaginationOptions } from './types';
import { getSupabaseAuthClient } from '../supabase';
import { getCanonicalAppUrl } from '@/lib/auth/url';

export class SupabaseDatabaseAdapter implements IDatabaseAdapter {
  private client: SupabaseClient;
  private authClientFactory: () => SupabaseClient | null;

  constructor(
    adminClient: SupabaseClient,
    authClient?: SupabaseClient | (() => SupabaseClient | null)
  ) {
    this.client = adminClient;
    if (typeof authClient === 'function') {
      this.authClientFactory = authClient;
    } else if (authClient) {
      this.authClientFactory = () => authClient;
    } else {
      this.authClientFactory = () => getSupabaseAuthClient();
    }
  }

  private getAuthClient(): SupabaseClient {
    const client = this.authClientFactory ? this.authClientFactory() : null;
    if (!client) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Supabase authentication client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.'
      );
    }
    return client;
  }

  // --- Users ---
  async getUserByEmail(email: string): Promise<UserAuthRecord | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !data) return null;
    return data as UserAuthRecord;
  }

  async getUserById(id: string): Promise<UserProfile | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select('id, email, name, avatar_url, created_at')
      .eq('id', id)
      .single();

    if (error || !data) return null;
    return data as UserProfile;
  }

  async isUserVerified(userId: string): Promise<boolean> {
    // Explicitly configured administrative auto-confirm override
    if (process.env.AUTH_AUTO_CONFIRM_EMAILS === 'true') {
      return true;
    }

    // Fail closed if administrative user lookup is unavailable
    if (typeof this.client.auth?.admin?.getUserById !== 'function') {
      return false;
    }

    try {
      const { data, error } = await this.client.auth.admin.getUserById(userId);
      if (error || !data?.user) return false;
      return Boolean(data.user.email_confirmed_at || data.user.confirmed_at);
    } catch {
      return false;
    }
  }

  async createUser(
    userData: {
      id?: string;
      email: string;
      name: string;
      password?: string;
      password_hash?: string;
      avatar_url?: string | null;
    },
    options?: {
      emailRedirectTo?: string;
    }
  ): Promise<UserProfile> {
    let userId = userData.id;
    let requiresVerification = false;

    if (!userId && userData.password) {
      const shouldAutoConfirm =
        process.env.AUTH_AUTO_CONFIRM_EMAILS === 'true' ||
        (process.env.NODE_ENV !== 'production' && process.env.AUTH_AUTO_CONFIRM_EMAILS !== 'false');

      if (!shouldAutoConfirm) {
        // Genuine public signup initiating email verification
        const authClient = this.getAuthClient();
        if (!authClient.auth?.signUp) {
          throw new Error('Supabase authentication client does not support signUp.');
        }

        const emailRedirectTo =
          options?.emailRedirectTo ||
          `${getCanonicalAppUrl()}/api/auth/callback`;

        const { data: signUpData, error: signUpError } = await authClient.auth.signUp({
          email: userData.email.toLowerCase(),
          password: userData.password,
          options: {
            data: {
              name: userData.name,
              avatar_url: userData.avatar_url || null,
            },
            emailRedirectTo,
          },
        });

        if (signUpError) {
          throw new Error(signUpError.message || 'Failed to register with Supabase Auth.');
        }

        if (!signUpData?.user) {
          throw new Error('Supabase Auth registration did not return a user.');
        }

        // In Supabase, if email is already registered and confirmed, identities is empty array []
        if (signUpData.user.identities && signUpData.user.identities.length === 0) {
          throw new Error('An account with this email address already exists.');
        }

        userId = signUpData.user.id;
        const isConfirmed = Boolean(
          signUpData.user.email_confirmed_at ||
          signUpData.user.confirmed_at ||
          signUpData.session
        );
        requiresVerification = !isConfirmed;
      } else if (this.client.auth?.admin?.createUser) {
        // Auto-confirm flow for local integration tests or administrative override
        const { data: authData, error: authError } = await this.client.auth.admin.createUser({
          email: userData.email.toLowerCase(),
          password: userData.password,
          email_confirm: true,
          user_metadata: {
            name: userData.name,
            avatar_url: userData.avatar_url || null,
          },
        });

        if (authError || !authData?.user) {
          throw new Error(authError?.message || 'Failed to create user in Supabase Auth.');
        }
        userId = authData.user.id;
        requiresVerification = false;
      } else {
        const authClient = this.getAuthClient();
        if (!authClient.auth?.signUp) {
          throw new Error('Supabase authentication client does not support signUp.');
        }
        const { data: signUpData, error: signUpError } = await authClient.auth.signUp({
          email: userData.email.toLowerCase(),
          password: userData.password,
          options: {
            data: {
              name: userData.name,
              avatar_url: userData.avatar_url || null,
            },
          },
        });

        if (signUpError || !signUpData?.user) {
          throw new Error(signUpError?.message || 'Failed to register with Supabase Auth.');
        }
        userId = signUpData.user.id;
        requiresVerification = false;
      }
    }

    if (!userId) {
      userId = uuidv4();
    }

    const { data, error } = await this.client
      .from('profiles')
      .upsert({
        id: userId,
        email: userData.email.toLowerCase(),
        name: userData.name,
        avatar_url: userData.avatar_url || null,
      })
      .select('id, email, name, avatar_url, created_at')
      .single();

    if (error) {
      // Partial failure recovery: delete newly created auth user so we don't leave an orphan in auth.users
      if (userData.password && userId && this.client.auth?.admin?.deleteUser) {
        try {
          await this.client.auth.admin.deleteUser(userId);
        } catch {
          // Swallow rollback error and throw original profile failure
        }
      }
      throw new Error(`Failed to create profile: ${error.message}`);
    }

    return {
      ...(data as UserProfile),
      requiresVerification,
    };
  }

  async authenticateUser(email: string, password: string): Promise<UserProfile | null> {
    const authClient = this.getAuthClient();

    if (!authClient.auth?.signInWithPassword) {
      return null;
    }

    const { data, error } = await authClient.auth.signInWithPassword({
      email: email.toLowerCase(),
      password,
    });

    if (error) {
      if (
        error.message?.toLowerCase().includes('not confirmed') ||
        error.message?.toLowerCase().includes('unverified')
      ) {
        const unconfirmedError: any = new Error(
          'Please verify your email address before logging in. A confirmation email was sent to your inbox.'
        );
        unconfirmedError.status = 403;
        unconfirmedError.code = 'email_not_confirmed';
        throw unconfirmedError;
      }
      return null;
    }

    if (!data?.user) {
      return null;
    }

    // Check verification status on user object if returned
    const isConfirmed = Boolean(
      data.user.email_confirmed_at ||
      data.user.confirmed_at ||
      process.env.AUTH_AUTO_CONFIRM_EMAILS === 'true'
    );
    if (!isConfirmed) {
      const unconfirmedError: any = new Error(
        'Please verify your email address before logging in. A confirmation email was sent to your inbox.'
      );
      unconfirmedError.status = 403;
      unconfirmedError.code = 'email_not_confirmed';
      throw unconfirmedError;
    }

    let profile = await this.getUserById(data.user.id);
    if (!profile) {
      // Recover missing profile from auth user metadata
      const name = (data.user.user_metadata?.name as string) || email.split('@')[0];
      const avatar_url = (data.user.user_metadata?.avatar_url as string) || null;
      try {
        profile = await this.createUser({
          id: data.user.id,
          email: data.user.email || email.toLowerCase(),
          name,
          avatar_url,
        });
      } catch (err: any) {
        // Operational failure: Fail closed! Never return an in-memory profile
        throw new Error(`Failed to recover user profile in database: ${err.message}`);
      }
    }

    if (!profile) {
      throw new Error('Failed to load user profile after authentication.');
    }

    return profile;
  }

  // --- Projects ---
  async createProject(projectData: {
    name: string;
    description: string;
    hackathon_name?: string | null;
    leader_id: string;
  }): Promise<ProjectWithDetails> {
    const inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();

    const { data: project, error: projError } = await this.client
      .from('projects')
      .insert({
        name: projectData.name,
        description: projectData.description,
        hackathon_name: projectData.hackathon_name || null,
        invite_code: inviteCode,
        leader_id: projectData.leader_id,
      })
      .select('*')
      .single();

    if (projError || !project) {
      throw new Error(`Failed to create project: ${projError?.message}`);
    }

    const { data: membership, error: memError } = await this.client
      .from('project_members')
      .insert({
        project_id: project.id,
        user_id: projectData.leader_id,
        role: 'leader',
      })
      .select('*')
      .single();

    if (memError || !membership) {
      throw new Error(`Failed to create leader membership: ${memError?.message}`);
    }

    const leaderProfile = await this.getUserById(projectData.leader_id);

    return {
      ...(project as Project),
      members: [{ ...(membership as ProjectMember), user: leaderProfile || undefined }],
      memberCount: 1,
      currentUserRole: 'leader',
      tasksCount: 0,
      contributionsCount: 0,
    };
  }

  async getProjectById(id: string): Promise<ProjectWithDetails | null> {
    const { data: project, error: projError } = await this.client
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (projError || !project) return null;

    const members = await this.getProjectMembers(id);

    // Database-side exact head counts without transferring full rows over the network
    const [{ count: tasksCount }, { count: contributionsCount }] = await Promise.all([
      this.client.from('tasks').select('*', { count: 'exact', head: true }).eq('project_id', id),
      this.client.from('contributions').select('*', { count: 'exact', head: true }).eq('project_id', id),
    ]);

    return {
      ...(project as Project),
      members,
      memberCount: members.length,
      tasksCount: tasksCount ?? 0,
      contributionsCount: contributionsCount ?? 0,
    };
  }

  async getProjectByInviteCode(inviteCode: string): Promise<Project | null> {
    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('invite_code', inviteCode.trim().toUpperCase())
      .single();

    if (error || !data) return null;
    return data as Project;
  }

  async getUserProjects(userId: string, pagination?: PaginationOptions): Promise<ProjectWithDetails[]> {
    let membershipQuery = this.client
      .from('project_members')
      .select('project_id, role')
      .eq('user_id', userId);

    if (pagination?.limit !== undefined) {
      const from = pagination.offset || 0;
      membershipQuery = membershipQuery.range(from, from + pagination.limit - 1);
    }

    const { data: memberships, error } = await membershipQuery;

    if (error || !memberships || memberships.length === 0) return [];

    const projectIds = memberships.map((m) => m.project_id);

    const { data: projects } = await this.client
      .from('projects')
      .select('*')
      .in('id', projectIds);

    if (!projects) return [];

    const results: ProjectWithDetails[] = [];
    for (const p of projects) {
      const members = await this.getProjectMembers(p.id);
      const myMembership = memberships.find((m) => m.project_id === p.id);
      results.push({
        ...(p as Project),
        members,
        memberCount: members.length,
        currentUserRole: myMembership?.role as ProjectRole,
      });
    }

    return results;
  }

  async updateProject(
    projectId: string,
    leaderId: string,
    updateData: { name?: string; description?: string; hackathon_name?: string | null }
  ): Promise<Project> {
    const { data, error } = await this.client
      .from('projects')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('leader_id', leaderId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to update project: ${error?.message}`);
    }
    return data as Project;
  }

  // --- Membership ---
  async getProjectMembers(projectId: string): Promise<ProjectMember[]> {
    const { data, error } = await this.client
      .from('project_members')
      .select('*, profiles:user_id(id, email, name, avatar_url, created_at)')
      .eq('project_id', projectId);

    if (error || !data) return [];
    return data.map((item: any) => ({
      id: item.id,
      project_id: item.project_id,
      user_id: item.user_id,
      role: item.role,
      joined_at: item.joined_at,
      user: item.profiles,
    }));
  }

  async joinProject(projectId: string, userId: string, role: ProjectRole = 'member'): Promise<ProjectMember> {
    // Check if already a member
    const { data: existing } = await this.client
      .from('project_members')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .single();

    if (existing) {
      return existing as ProjectMember;
    }

    // Insert with database-level trigger enforcing max 6 members
    const { data, error } = await this.client
      .from('project_members')
      .insert({
        project_id: projectId,
        user_id: userId,
        role,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(error.message);
    }

    const user = await this.getUserById(userId);
    return {
      ...(data as ProjectMember),
      user: user || undefined,
    };
  }

  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    const { count } = await this.client
      .from('project_members')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    return Boolean(count && count > 0);
  }

  async isProjectLeader(projectId: string, userId: string): Promise<boolean> {
    const { count } = await this.client
      .from('project_members')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('role', 'leader');

    return Boolean(count && count > 0);
  }

  // --- Tasks ---
  async createTask(taskData: {
    project_id: string;
    title: string;
    description: string;
    assigned_to: string;
    created_by: string;
    deadline?: string | null;
  }): Promise<Task> {
    const isLeader = await this.isProjectLeader(taskData.project_id, taskData.created_by);
    if (!isLeader) {
      throw new Error('Only the team leader can create tasks.');
    }

    const isAssigneeMember = await this.isProjectMember(taskData.project_id, taskData.assigned_to);
    if (!isAssigneeMember) {
      throw new Error('Assigned user must be a member of this project.');
    }

    const { data, error } = await this.client
      .from('tasks')
      .insert({
        project_id: taskData.project_id,
        title: taskData.title,
        description: taskData.description,
        assigned_to: taskData.assigned_to,
        created_by: taskData.created_by,
        status: 'Assigned',
        deadline: taskData.deadline || null,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create task: ${error?.message}`);
    }
    return data as Task;
  }

  async updateTask(
    taskId: string,
    actorUserId: string,
    updates: {
      title?: string;
      description?: string;
      assigned_to?: string;
      status?: TaskStatus;
      deadline?: string | null;
    }
  ): Promise<Task> {
    const task = await this.getTaskById(taskId);
    if (!task) throw new Error('Task not found.');

    const isLeader = await this.isProjectLeader(task.project_id, actorUserId);
    const isAssignee = task.assigned_to === actorUserId;

    if (!isLeader && !isAssignee) {
      throw new Error('You do not have permission to modify this task.');
    }

    if (!isLeader && isAssignee) {
      if (updates.title !== undefined || updates.description !== undefined || updates.assigned_to !== undefined || updates.deadline !== undefined) {
        throw new Error('Members cannot change task details, reassign tasks, or set deadlines.');
      }
      if (updates.status && !['In Progress', 'Submitted'].includes(updates.status)) {
        throw new Error(`Members can only update status to 'In Progress' or 'Submitted'.`);
      }
    } else if (isLeader) {
      if (updates.assigned_to !== undefined) {
        const isMember = await this.isProjectMember(task.project_id, updates.assigned_to);
        if (!isMember) {
          throw new Error('Reassigned user must be a member of this project.');
        }
      }
    }

    const { data, error } = await this.client
      .from('tasks')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to update task: ${error?.message}`);
    }
    return data as Task;
  }

  async getProjectTasks(projectId: string, pagination?: PaginationOptions): Promise<Task[]> {
    let query = this.client
      .from('tasks')
      .select('*, assignee:profiles!tasks_assigned_to_fkey(id, email, name, avatar_url), creator:profiles!tasks_created_by_fkey(id, email, name, avatar_url)')
      .eq('project_id', projectId);

    if (pagination?.limit !== undefined) {
      const from = pagination.offset || 0;
      query = query.range(from, from + pagination.limit - 1);
    }

    const { data, error } = await query;

    if (error || !data) return [];
    return data as Task[];
  }

  async getTaskById(taskId: string): Promise<Task | null> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*, assignee:profiles!tasks_assigned_to_fkey(id, email, name, avatar_url), creator:profiles!tasks_created_by_fkey(id, email, name, avatar_url)')
      .eq('id', taskId)
      .single();

    if (error || !data) return null;
    return data as Task;
  }

  // --- Contributions ---
  async createContribution(
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
  ): Promise<Contribution> {
    const isMember = await this.isProjectMember(contributionData.project_id, contributionData.contributor_id);
    if (!isMember) {
      throw new Error('Only project members can publish contributions.');
    }

    if (contributionData.task_id) {
      const linkedTask = await this.getTaskById(contributionData.task_id);
      if (!linkedTask || linkedTask.project_id !== contributionData.project_id) {
        throw new Error('Task does not belong to this project.');
      }
    }

    const { data: contrib, error: cError } = await this.client
      .from('contributions')
      .insert({
        project_id: contributionData.project_id,
        title: contributionData.title,
        description: contributionData.description,
        contributor_id: contributionData.contributor_id,
        contributor_name: contributionData.contributor_name,
        task_id: contributionData.task_id || null,
        version_label: contributionData.version_label || null,
        usage_instructions: contributionData.usage_instructions,
        dependencies: contributionData.dependencies,
      })
      .select('*')
      .single();

    if (cError || !contrib) {
      throw new Error(`Failed to create contribution: ${cError?.message}`);
    }

    if (files.length > 0) {
      const fileInserts = files.map((f) => ({
        id: f.id,
        contribution_id: contrib.id,
        project_id: contributionData.project_id,
        file_name: f.file_name,
        file_size: f.file_size,
        mime_type: f.mime_type,
        storage_path: f.storage_path,
        checksum: f.checksum,
      }));

      const { error: fError } = await this.client
        .from('contribution_files')
        .insert(fileInserts);

      if (fError) {
        throw new Error(`Failed to save contribution file records: ${fError.message}`);
      }
    }

    return (await this.getContributionById(contrib.id)) as Contribution;
  }

  async getProjectContributions(
    projectId: string,
    filters?: { search?: string; contributorId?: string; taskId?: string },
    pagination?: PaginationOptions
  ): Promise<Contribution[]> {
    let query = this.client
      .from('contributions')
      .select('*, files:contribution_files(*), task:tasks(*)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (filters?.contributorId) {
      query = query.eq('contributor_id', filters.contributorId);
    }
    if (filters?.taskId) {
      query = query.eq('task_id', filters.taskId);
    }

    if (pagination?.limit !== undefined && !filters?.search) {
      const from = pagination.offset || 0;
      query = query.range(from, from + pagination.limit - 1);
    }

    const { data, error } = await query;
    if (error || !data) return [];

    let list = data as Contribution[];
    if (filters?.search) {
      const s = filters.search.toLowerCase();
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(s) ||
          c.description.toLowerCase().includes(s) ||
          c.contributor_name.toLowerCase().includes(s)
      );

      if (pagination?.limit !== undefined) {
        const start = pagination.offset || 0;
        list = list.slice(start, start + pagination.limit);
      }
    }

    return list;
  }

  async getContributionById(contributionId: string): Promise<Contribution | null> {
    const { data, error } = await this.client
      .from('contributions')
      .select('*, files:contribution_files(*), task:tasks(*)')
      .eq('id', contributionId)
      .single();

    if (error || !data) return null;
    return data as Contribution;
  }

  async getContributionFileById(fileId: string): Promise<ContributionFile | null> {
    const { data, error } = await this.client
      .from('contribution_files')
      .select('*')
      .eq('id', fileId)
      .single();

    if (error || !data) return null;
    return data as ContributionFile;
  }

  // --- Common Development Workspace Operations ---
  async getWorkspaceTree(projectId: string): Promise<WorkspaceTreeItem[]> {
    const { data: nodes, error } = await this.client
      .from('workspace_nodes')
      .select('*')
      .eq('project_id', projectId)
      .is('deleted_at', null);

    if (error || !nodes) return [];

    const nodeMap = new Map<string, WorkspaceTreeItem>();
    nodes.forEach((n: any) => {
      nodeMap.set(n.id, { ...n, children: n.type === 'folder' ? [] : undefined });
    });

    const roots: WorkspaceTreeItem[] = [];
    nodes.forEach((n: any) => {
      const item = nodeMap.get(n.id)!;
      if (!n.parent_id || !nodeMap.has(n.parent_id)) {
        roots.push(item);
      } else {
        const parent = nodeMap.get(n.parent_id);
        if (parent && parent.children) {
          parent.children.push(item);
        } else {
          roots.push(item);
        }
      }
    });

    const sortItems = (items: WorkspaceTreeItem[]) => {
      items.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      items.forEach((item) => {
        if (item.children) sortItems(item.children);
      });
    };

    sortItems(roots);
    return roots;
  }

  async getWorkspaceNode(nodeId: string): Promise<WorkspaceNode | null> {
    const { data, error } = await this.client
      .from('workspace_nodes')
      .select('*')
      .eq('id', nodeId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;
    return data as WorkspaceNode;
  }

  async createWorkspaceNode(input: {
    project_id: string;
    parent_id?: string | null;
    name: string;
    type: WorkspaceNodeType;
    initialContent?: string;
    author_id: string;
    author_name: string;
  }): Promise<WorkspaceNode> {
    const cleanName = input.name.trim();
    if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName.includes('/') || cleanName.includes('\\') || cleanName.includes('\0')) {
      throw new Error('Invalid file or folder name. Name cannot be empty or contain path separators.');
    }

    if (input.initialContent && Buffer.byteLength(input.initialContent, 'utf-8') > 10 * 1024 * 1024) {
      throw new Error('File content exceeds the maximum size limit of 10MB.');
    }

    const checksum = input.type === 'file'
      ? crypto.createHash('sha256').update(input.initialContent ?? '').digest('hex')
      : null;

    const { data, error } = await this.client.rpc('create_workspace_node_atomic', {
      p_project_id: input.project_id,
      p_parent_id: input.parent_id || null,
      p_name: cleanName,
      p_type: input.type,
      p_initial_content: input.initialContent ?? '',
      p_author_id: input.author_id,
      p_author_name: input.author_name,
      p_checksum: checksum,
    });

    if (error || !data) {
      throw new Error(`Failed to create workspace item: ${error?.message || 'Database transaction error'}`);
    }

    const node = data as WorkspaceNode;
    if (input.type === 'file' && node.current_revision !== 1) {
      throw new Error('Transaction verification failed: Initial revision was not properly persisted.');
    }

    return node;
  }

  async updateWorkspaceNode(
    nodeId: string,
    updates: { name?: string; parent_id?: string | null },
    author_id: string,
    author_name: string
  ): Promise<WorkspaceNode> {
    const newName = updates.name !== undefined ? updates.name.trim() : undefined;
    if (newName !== undefined) {
      if (!newName || newName === '.' || newName === '..' || newName.includes('/') || newName.includes('\\') || newName.includes('\0')) {
        throw new Error('Invalid name. Cannot be empty or contain path separators.');
      }
    }

    const hasParentUpdate = updates.parent_id !== undefined;

    const { data, error } = await this.client.rpc('update_workspace_node_atomic', {
      p_node_id: nodeId,
      p_name: newName || null,
      p_parent_id: hasParentUpdate ? (updates.parent_id || null) : null,
      p_author_id: author_id,
      p_author_name: author_name,
      p_project_id: null,
      p_update_parent: hasParentUpdate,
    });

    if (error || !data) {
      throw new Error(`Failed to update workspace item: ${error?.message || 'Database transaction error'}`);
    }

    return data as WorkspaceNode;
  }

  async deleteWorkspaceNode(nodeId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('delete_workspace_node_atomic', {
      p_node_id: nodeId,
    });

    if (error || !data) {
      throw new Error(`Failed to delete workspace item: ${error?.message || 'Database transaction error'}`);
    }

    return data.success === true;
  }

  async getWorkspaceFile(fileId: string): Promise<WorkspaceFileDetail | null> {
    const node = await this.getWorkspaceNode(fileId);
    if (!node || node.type !== 'file') return null;

    const { data: revisions } = await this.client
      .from('workspace_revisions')
      .select('*')
      .eq('node_id', fileId)
      .order('revision_number', { ascending: false });

    const latestRev = revisions && revisions[0];
    const content = latestRev ? latestRev.content : '';

    return {
      ...node,
      content,
      revisions: revisions || [],
    };
  }

  async saveWorkspaceFile(
    fileId: string,
    content: string,
    baseRevision: number | undefined,
    author_id: string,
    author_name: string,
    forceOverwrite?: boolean
  ): Promise<{ file: WorkspaceFileDetail; conflict?: boolean; currentRevision?: number }> {
    if (forceOverwrite !== undefined && typeof forceOverwrite !== 'boolean') {
      throw new Error('Invalid forceOverwrite parameter. Must be a boolean (true or false).');
    }

    const isForce = forceOverwrite === true;

    if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1)
    ) {
      throw new Error('Invalid base revision number. Must be a positive integer.');
    }

    if (baseRevision === undefined && !isForce) {
      throw new Error('Concurrency check required: baseRevision must be specified for workspace saves.');
    }

    if (Buffer.byteLength(content, 'utf-8') > 10 * 1024 * 1024) {
      throw new Error('File content exceeds the maximum size limit of 10MB.');
    }

    const checksum = crypto.createHash('sha256').update(content).digest('hex');

    const { data: rpcRes, error: rpcErr } = await this.client.rpc('save_workspace_file_atomic', {
      p_file_id: fileId,
      p_content: content,
      p_base_revision: baseRevision !== undefined ? baseRevision : null,
      p_author_id: author_id,
      p_author_name: author_name,
      p_checksum: checksum,
      p_force_overwrite: isForce,
    });

    if (rpcErr) {
      throw new Error(`Failed to save revision: ${rpcErr.message}`);
    }

    if (!rpcRes) {
      throw new Error('Failed to save revision: Database returned empty response.');
    }

    if (rpcRes.conflict) {
      const currentFile = await this.getWorkspaceFile(fileId);
      return {
        file: currentFile!,
        conflict: true,
        currentRevision: rpcRes.currentRevision,
      };
    }

    const updated = await this.getWorkspaceFile(fileId);
    return {
      file: updated!,
      conflict: false,
    };
  }

  async getWorkspaceFileRevisions(fileId: string, pagination?: PaginationOptions): Promise<WorkspaceRevision[]> {
    let query = this.client
      .from('workspace_revisions')
      .select('*')
      .eq('node_id', fileId)
      .order('revision_number', { ascending: false });

    if (pagination?.limit !== undefined) {
      const from = pagination.offset || 0;
      query = query.range(from, from + pagination.limit - 1);
    }

    const { data, error } = await query;

    if (error || !data) return [];
    return data as WorkspaceRevision[];
  }

  async restoreWorkspaceRevision(
    fileId: string,
    targetRevisionNumber: number,
    author_id: string,
    author_name: string,
    baseRevision?: number,
    forceOverwrite?: boolean
  ): Promise<WorkspaceFileDetail> {
    if (
      typeof targetRevisionNumber !== 'number' ||
      !Number.isInteger(targetRevisionNumber) ||
      targetRevisionNumber < 1
    ) {
      throw new Error('Invalid target revision number. Must be a positive integer.');
    }

    if (forceOverwrite !== undefined && typeof forceOverwrite !== 'boolean') {
      throw new Error('Invalid forceOverwrite parameter. Must be a boolean (true or false).');
    }

    const isForce = forceOverwrite === true;

    if (!isForce && (baseRevision === undefined || typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1)) {
      throw new Error('Concurrency check required: baseRevision must be specified for workspace restoration.');
    }

    if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1)
    ) {
      throw new Error('Invalid base revision number. Must be a positive integer.');
    }

    const node = await this.getWorkspaceNode(fileId);
    if (!node || node.type !== 'file') throw new Error('Workspace file not found.');

    if (!isForce && baseRevision !== undefined && node.current_revision !== baseRevision) {
      throw new Error(`Conflict: File has been updated to revision ${node.current_revision} by another teammate.`);
    }

    const { data: targetRev, error } = await this.client
      .from('workspace_revisions')
      .select('*')
      .eq('node_id', fileId)
      .eq('revision_number', targetRevisionNumber)
      .single();

    if (error || !targetRev) {
      throw new Error(`Revision ${targetRevisionNumber} not found.`);
    }

    const saved = await this.saveWorkspaceFile(
      fileId,
      targetRev.content,
      baseRevision,
      author_id,
      `${author_name} (Restored Rev #${targetRevisionNumber})`,
      isForce
    );

    if (saved.conflict) {
      throw new Error(`Conflict: File has been updated to revision ${saved.currentRevision} by another teammate.`);
    }

    return saved.file;
  }
}

