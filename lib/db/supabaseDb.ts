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
} from '../types';
import { IDatabaseAdapter } from './types';

export class SupabaseDatabaseAdapter implements IDatabaseAdapter {
  private client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
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

  async createUser(userData: {
    email: string;
    name: string;
    password_hash?: string;
    avatar_url?: string | null;
  }): Promise<UserProfile> {
    const id = uuidv4();
    const { data, error } = await this.client
      .from('profiles')
      .insert({
        id,
        email: userData.email.toLowerCase(),
        name: userData.name,
        avatar_url: userData.avatar_url || null,
      })
      .select('id, email, name, avatar_url, created_at')
      .single();

    if (error) {
      throw new Error(`Failed to create profile: ${error.message}`);
    }
    return data as UserProfile;
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
    const tasks = await this.getProjectTasks(id);
    const contributions = await this.getProjectContributions(id);

    return {
      ...(project as Project),
      members,
      memberCount: members.length,
      tasksCount: tasks.length,
      contributionsCount: contributions.length,
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

  async getUserProjects(userId: string): Promise<ProjectWithDetails[]> {
    const { data: memberships, error } = await this.client
      .from('project_members')
      .select('project_id, role')
      .eq('user_id', userId);

    if (error || !memberships) return [];

    const projectIds = memberships.map((m) => m.project_id);
    if (projectIds.length === 0) return [];

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
      if (updates.status && !['In Progress', 'Submitted'].includes(updates.status)) {
        throw new Error(`Members can only update status to 'In Progress' or 'Submitted'.`);
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

  async getProjectTasks(projectId: string): Promise<Task[]> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*, assignee:profiles!tasks_assigned_to_fkey(id, email, name, avatar_url), creator:profiles!tasks_created_by_fkey(id, email, name, avatar_url)')
      .eq('project_id', projectId);

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
    filters?: { search?: string; contributorId?: string; taskId?: string }
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
}
