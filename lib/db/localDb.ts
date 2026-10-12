import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
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
import bcrypt from 'bcryptjs';
import { IDatabaseAdapter, PaginationOptions } from './types';
import { isVercelEnvironment } from './config';

interface Schema {
  users: UserAuthRecord[];
  projects: Project[];
  project_members: ProjectMember[];
  tasks: Task[];
  contributions: Contribution[];
  contribution_files: ContributionFile[];
  workspace_nodes: WorkspaceNode[];
  workspace_revisions: WorkspaceRevision[];
}

export class LocalDatabaseAdapter implements IDatabaseAdapter {
  private filePath: string;
  private workspacesBaseDir: string;
  private memoryLock: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    if (isVercelEnvironment()) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Local JSON database cannot be instantiated in a Vercel environment. Vercel deployments require an explicitly configured persistent database (STORAGE_DRIVER=supabase).'
      );
    }
    this.filePath = filePath || process.env.LOCAL_DB_PATH || path.join(process.cwd(), 'data', 'hackmate.json');
    this.workspacesBaseDir = path.join(path.dirname(this.filePath), 'workspaces');
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.workspacesBaseDir)) {
      fs.mkdirSync(this.workspacesBaseDir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      const initial: Schema = {
        users: [],
        projects: [],
        project_members: [],
        tasks: [],
        contributions: [],
        contribution_files: [],
        workspace_nodes: [],
        workspace_revisions: [],
      };
      fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf-8');
    }
  }

  private async withLock<T>(fn: (data: Schema) => Promise<{ result: T; dataToSave?: Schema }>): Promise<T> {
    let unlock: () => void;
    const lockWait = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    const previousLock = this.memoryLock;
    this.memoryLock = lockWait;

    await previousLock;

    try {
      let content = '{}';
      if (fs.existsSync(this.filePath)) {
        content = await fs.promises.readFile(this.filePath, 'utf-8');
      }
      const parsed: any = JSON.parse(content || '{}');
      const data: Schema = {
        users: parsed.users || [],
        projects: parsed.projects || [],
        project_members: parsed.project_members || [],
        tasks: parsed.tasks || [],
        contributions: parsed.contributions || [],
        contribution_files: parsed.contribution_files || [],
        workspace_nodes: parsed.workspace_nodes || [],
        workspace_revisions: parsed.workspace_revisions || [],
      };
      
      const { result, dataToSave } = await fn(data);
      if (dataToSave) {
        await fs.promises.writeFile(this.filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      }
      return result;
    } finally {
      unlock!();
    }
  }

  // --- Users ---
  async getUserByEmail(email: string): Promise<UserAuthRecord | null> {
    return this.withLock(async (data) => {
      const user = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      return { result: user ? { ...user } : null };
    });
  }

  async getUserById(id: string): Promise<UserProfile | null> {
    return this.withLock(async (data) => {
      const user = data.users.find((u) => u.id === id);
      if (!user) return { result: null };
      const { password_hash, ...profile } = user;
      return { result: profile };
    });
  }

  async createUser(userData: {
    id?: string;
    email: string;
    name: string;
    password?: string;
    password_hash?: string;
    avatar_url?: string | null;
  }): Promise<UserProfile> {
    return this.withLock(async (data) => {
      const existing = data.users.find((u) => u.email.toLowerCase() === userData.email.toLowerCase());
      if (existing) {
        throw new Error('User with this email already exists.');
      }

      let passwordHash = userData.password_hash;
      if (!passwordHash && userData.password) {
        const salt = await bcrypt.genSalt(10);
        passwordHash = await bcrypt.hash(userData.password, salt);
      }

      const newUser: UserAuthRecord = {
        id: userData.id || uuidv4(),
        email: userData.email.trim(),
        name: userData.name.trim(),
        avatar_url: userData.avatar_url || null,
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      };

      data.users.push(newUser);
      const { password_hash, ...profile } = newUser;
      return { result: profile, dataToSave: data };
    });
  }

  async authenticateUser(email: string, password: string): Promise<UserProfile | null> {
    return this.withLock(async (data) => {
      const user = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user || !user.password_hash) {
        return { result: null };
      }

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return { result: null };
      }

      const { password_hash, ...profile } = user;
      return { result: profile };
    });
  }

  async isUserVerified(_userId: string): Promise<boolean> {
    return true;
  }

  // --- Projects ---
  async createProject(projectData: {
    name: string;
    description: string;
    hackathon_name?: string | null;
    leader_id: string;
  }): Promise<ProjectWithDetails> {
    return this.withLock(async (data) => {
      const leader = data.users.find((u) => u.id === projectData.leader_id);
      if (!leader) {
        throw new Error('Leader user does not exist.');
      }

      const inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      const now = new Date().toISOString();
      const projectId = uuidv4();

      const newProject: Project = {
        id: projectId,
        name: projectData.name.trim(),
        description: projectData.description.trim(),
        hackathon_name: projectData.hackathon_name?.trim() || null,
        invite_code: inviteCode,
        leader_id: projectData.leader_id,
        created_at: now,
        updated_at: now,
      };

      const leaderMembership: ProjectMember = {
        id: uuidv4(),
        project_id: projectId,
        user_id: projectData.leader_id,
        role: 'leader',
        joined_at: now,
      };

      data.projects.push(newProject);
      data.project_members.push(leaderMembership);

      const { password_hash, ...leaderProfile } = leader;
      const detailedMembership: ProjectMember = {
        ...leaderMembership,
        user: leaderProfile,
      };

      const result: ProjectWithDetails = {
        ...newProject,
        members: [detailedMembership],
        memberCount: 1,
        currentUserRole: 'leader',
        tasksCount: 0,
        contributionsCount: 0,
      };

      return { result, dataToSave: data };
    });
  }

  async getProjectById(id: string): Promise<ProjectWithDetails | null> {
    return this.withLock(async (data) => {
      const project = data.projects.find((p) => p.id === id);
      if (!project) return { result: null };

      const members = data.project_members
        .filter((pm) => pm.project_id === id)
        .map((pm) => {
          const user = data.users.find((u) => u.id === pm.user_id);
          const userProfile = user ? { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at } : undefined;
          return { ...pm, user: userProfile };
        });

      const tasksCount = data.tasks.filter((t) => t.project_id === id).length;
      const contributionsCount = data.contributions.filter((c) => c.project_id === id).length;

      const result: ProjectWithDetails = {
        ...project,
        members,
        memberCount: members.length,
        tasksCount,
        contributionsCount,
      };

      return { result };
    });
  }

  async getProjectByInviteCode(inviteCode: string): Promise<Project | null> {
    return this.withLock(async (data) => {
      const project = data.projects.find((p) => p.invite_code.toUpperCase() === inviteCode.trim().toUpperCase());
      return { result: project ? { ...project } : null };
    });
  }

  async getUserProjects(userId: string, pagination?: PaginationOptions): Promise<ProjectWithDetails[]> {
    return this.withLock(async (data) => {
      const memberships = data.project_members.filter((pm) => pm.user_id === userId);
      const projectIds = memberships.map((m) => m.project_id);

      const projects = data.projects.filter((p) => projectIds.includes(p.id));

      let detailedProjects: ProjectWithDetails[] = projects.map((project) => {
        const members = data.project_members
          .filter((pm) => pm.project_id === project.id)
          .map((pm) => {
            const user = data.users.find((u) => u.id === pm.user_id);
            const userProfile = user ? { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at } : undefined;
            return { ...pm, user: userProfile };
          });

        const myMembership = memberships.find((m) => m.project_id === project.id);
        const tasksCount = data.tasks.filter((t) => t.project_id === project.id).length;
        const contributionsCount = data.contributions.filter((c) => c.project_id === project.id).length;

        return {
          ...project,
          members,
          memberCount: members.length,
          currentUserRole: myMembership?.role,
          tasksCount,
          contributionsCount,
        };
      });

      if (pagination) {
        const start = pagination.offset || 0;
        const end = pagination.limit !== undefined ? start + pagination.limit : undefined;
        detailedProjects = detailedProjects.slice(start, end);
      }

      return { result: detailedProjects };
    });
  }

  async updateProject(
    projectId: string,
    leaderId: string,
    updateData: { name?: string; description?: string; hackathon_name?: string | null }
  ): Promise<Project> {
    return this.withLock(async (data) => {
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) throw new Error('Project not found.');
      if (project.leader_id !== leaderId) throw new Error('Only the team leader can edit project details.');

      if (updateData.name !== undefined) project.name = updateData.name.trim();
      if (updateData.description !== undefined) project.description = updateData.description.trim();
      if (updateData.hackathon_name !== undefined) project.hackathon_name = updateData.hackathon_name?.trim() || null;
      project.updated_at = new Date().toISOString();

      return { result: { ...project }, dataToSave: data };
    });
  }

  // --- Membership & Concurrency-Safe 6-Member Limit ---
  async getProjectMembers(projectId: string): Promise<ProjectMember[]> {
    return this.withLock(async (data) => {
      const members = data.project_members
        .filter((pm) => pm.project_id === projectId)
        .map((pm) => {
          const user = data.users.find((u) => u.id === pm.user_id);
          const userProfile = user ? { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at } : undefined;
          return { ...pm, user: userProfile };
        });
      return { result: members };
    });
  }

  async joinProject(projectId: string, userId: string, role: ProjectRole = 'member'): Promise<ProjectMember> {
    return this.withLock(async (data) => {
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) throw new Error('Project not found.');

      const user = data.users.find((u) => u.id === userId);
      if (!user) throw new Error('User not found.');

      // Check if already a member
      const existing = data.project_members.find(
        (pm) => pm.project_id === projectId && pm.user_id === userId
      );
      if (existing) {
        return { result: { ...existing } };
      }

      // CRITICAL REQUIREMENT: Concurrency-safe limit check
      // A project must support 1 leader and up to 5 additional members (max 6 total).
      const currentCount = data.project_members.filter((pm) => pm.project_id === projectId).length;
      if (currentCount >= 6) {
        throw new Error('Team is full. A hackathon project cannot have more than 6 members (1 leader and up to 5 teammates).');
      }

      const membership: ProjectMember = {
        id: uuidv4(),
        project_id: projectId,
        user_id: userId,
        role: project.leader_id === userId ? 'leader' : role,
        joined_at: new Date().toISOString(),
      };

      data.project_members.push(membership);

      const { password_hash, ...profile } = user;
      return { result: { ...membership, user: profile }, dataToSave: data };
    });
  }

  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    return this.withLock(async (data) => {
      const member = data.project_members.some((pm) => pm.project_id === projectId && pm.user_id === userId);
      return { result: member };
    });
  }

  async isProjectLeader(projectId: string, userId: string): Promise<boolean> {
    return this.withLock(async (data) => {
      const leader = data.project_members.some((pm) => pm.project_id === projectId && pm.user_id === userId && pm.role === 'leader');
      return { result: leader };
    });
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
    return this.withLock(async (data) => {
      const project = data.projects.find((p) => p.id === taskData.project_id);
      if (!project) throw new Error('Project not found.');

      // Only leader can create tasks
      const isLeader = data.project_members.some(
        (pm) => pm.project_id === taskData.project_id && pm.user_id === taskData.created_by && pm.role === 'leader'
      );
      if (!isLeader) {
        throw new Error('Only the team leader can create tasks.');
      }

      // Assignee must be a project member
      const isAssigneeMember = data.project_members.some(
        (pm) => pm.project_id === taskData.project_id && pm.user_id === taskData.assigned_to
      );
      if (!isAssigneeMember) {
        throw new Error('Assigned user must be a member of this project.');
      }

      const now = new Date().toISOString();
      const newTask: Task = {
        id: uuidv4(),
        project_id: taskData.project_id,
        title: taskData.title.trim(),
        description: taskData.description.trim(),
        assigned_to: taskData.assigned_to,
        created_by: taskData.created_by,
        status: 'Assigned',
        deadline: taskData.deadline || null,
        created_at: now,
        updated_at: now,
      };

      data.tasks.push(newTask);

      const assignee = data.users.find((u) => u.id === newTask.assigned_to);
      const creator = data.users.find((u) => u.id === newTask.created_by);

      const enriched: Task = {
        ...newTask,
        assignee: assignee ? { id: assignee.id, email: assignee.email, name: assignee.name, avatar_url: assignee.avatar_url, created_at: assignee.created_at } : undefined,
        creator: creator ? { id: creator.id, email: creator.email, name: creator.name, avatar_url: creator.avatar_url, created_at: creator.created_at } : undefined,
      };

      return { result: enriched, dataToSave: data };
    });
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
    return this.withLock(async (data) => {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error('Task not found.');

      const isLeader = data.project_members.some(
        (pm) => pm.project_id === task.project_id && pm.user_id === actorUserId && pm.role === 'leader'
      );
      const isAssignee = task.assigned_to === actorUserId;

      if (!isLeader && !isAssignee) {
        throw new Error('You do not have permission to modify this task.');
      }

      // If actor is the assigned member (not the leader)
      if (!isLeader && isAssignee) {
        // Members can only update status to 'In Progress' or 'Submitted'
        if (updates.title !== undefined || updates.description !== undefined || updates.assigned_to !== undefined || updates.deadline !== undefined) {
          throw new Error('Members cannot change task details, reassign tasks, or set deadlines.');
        }

        if (updates.status !== undefined) {
          if (updates.status !== 'In Progress' && updates.status !== 'Submitted') {
            throw new Error(`Members can only update status to 'In Progress' or 'Submitted'. Status '${updates.status}' requires leader review.`);
          }
          task.status = updates.status;
        }
      } else if (isLeader) {
        // Leader has full editing and review permissions
        if (updates.title !== undefined) task.title = updates.title.trim();
        if (updates.description !== undefined) task.description = updates.description.trim();
        if (updates.assigned_to !== undefined) {
          const isMember = data.project_members.some(
            (pm) => pm.project_id === task.project_id && pm.user_id === updates.assigned_to
          );
          if (!isMember) throw new Error('Reassigned user must be a member of this project.');
          task.assigned_to = updates.assigned_to;
        }
        if (updates.deadline !== undefined) task.deadline = updates.deadline || null;
        if (updates.status !== undefined) task.status = updates.status;
      }

      task.updated_at = new Date().toISOString();

      const assignee = data.users.find((u) => u.id === task.assigned_to);
      const creator = data.users.find((u) => u.id === task.created_by);

      const enriched: Task = {
        ...task,
        assignee: assignee ? { id: assignee.id, email: assignee.email, name: assignee.name, avatar_url: assignee.avatar_url, created_at: assignee.created_at } : undefined,
        creator: creator ? { id: creator.id, email: creator.email, name: creator.name, avatar_url: creator.avatar_url, created_at: creator.created_at } : undefined,
      };

      return { result: enriched, dataToSave: data };
    });
  }

  async getProjectTasks(projectId: string, pagination?: PaginationOptions): Promise<Task[]> {
    return this.withLock(async (data) => {
      let tasks = data.tasks
        .filter((t) => t.project_id === projectId)
        .map((task) => {
          const assignee = data.users.find((u) => u.id === task.assigned_to);
          const creator = data.users.find((u) => u.id === task.created_by);
          return {
            ...task,
            assignee: assignee ? { id: assignee.id, email: assignee.email, name: assignee.name, avatar_url: assignee.avatar_url, created_at: assignee.created_at } : undefined,
            creator: creator ? { id: creator.id, email: creator.email, name: creator.name, avatar_url: creator.avatar_url, created_at: creator.created_at } : undefined,
          };
        });

      if (pagination) {
        const start = pagination.offset || 0;
        const end = pagination.limit !== undefined ? start + pagination.limit : undefined;
        tasks = tasks.slice(start, end);
      }

      return { result: tasks };
    });
  }

  async getTaskById(taskId: string): Promise<Task | null> {
    return this.withLock(async (data) => {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) return { result: null };

      const assignee = data.users.find((u) => u.id === task.assigned_to);
      const creator = data.users.find((u) => u.id === task.created_by);

      return {
        result: {
          ...task,
          assignee: assignee ? { id: assignee.id, email: assignee.email, name: assignee.name, avatar_url: assignee.avatar_url, created_at: assignee.created_at } : undefined,
          creator: creator ? { id: creator.id, email: creator.email, name: creator.name, avatar_url: creator.avatar_url, created_at: creator.created_at } : undefined,
        },
      };
    });
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
    return this.withLock(async (data) => {
      const isMember = data.project_members.some(
        (pm) => pm.project_id === contributionData.project_id && pm.user_id === contributionData.contributor_id
      );
      if (!isMember) {
        throw new Error('Only project members can publish contributions.');
      }

      if (contributionData.task_id) {
        const linkedTask = data.tasks.find((t) => t.id === contributionData.task_id);
        if (!linkedTask || linkedTask.project_id !== contributionData.project_id) {
          throw new Error('Task does not belong to this project.');
        }
      }

      const now = new Date().toISOString();
      const contributionId = uuidv4();

      const newContribution: Contribution = {
        id: contributionId,
        project_id: contributionData.project_id,
        title: contributionData.title.trim(),
        description: contributionData.description.trim(),
        contributor_id: contributionData.contributor_id,
        contributor_name: contributionData.contributor_name.trim(),
        task_id: contributionData.task_id || null,
        version_label: contributionData.version_label?.trim() || null,
        usage_instructions: contributionData.usage_instructions.trim(),
        dependencies: contributionData.dependencies.trim(),
        created_at: now,
        updated_at: now,
      };

      const fileRecords: ContributionFile[] = files.map((f) => ({
        id: f.id,
        contribution_id: contributionId,
        project_id: contributionData.project_id,
        file_name: f.file_name,
        file_size: f.file_size,
        mime_type: f.mime_type,
        storage_path: f.storage_path,
        checksum: f.checksum,
        uploaded_at: now,
      }));

      data.contributions.push(newContribution);
      data.contribution_files.push(...fileRecords);

      const task = newContribution.task_id
        ? data.tasks.find((t) => t.id === newContribution.task_id) || null
        : null;

      const result: Contribution = {
        ...newContribution,
        files: fileRecords,
        task,
      };

      return { result, dataToSave: data };
    });
  }

  async getProjectContributions(
    projectId: string,
    filters?: { search?: string; contributorId?: string; taskId?: string },
    pagination?: PaginationOptions
  ): Promise<Contribution[]> {
    return this.withLock(async (data) => {
      let list = data.contributions.filter((c) => c.project_id === projectId);

      if (filters?.search) {
        const query = filters.search.toLowerCase();
        list = list.filter(
          (c) =>
            c.title.toLowerCase().includes(query) ||
            c.description.toLowerCase().includes(query) ||
            c.contributor_name.toLowerCase().includes(query) ||
            (c.version_label && c.version_label.toLowerCase().includes(query))
        );
      }

      if (filters?.contributorId) {
        list = list.filter((c) => c.contributor_id === filters.contributorId);
      }

      if (filters?.taskId) {
        list = list.filter((c) => c.task_id === filters.taskId);
      }

      // Sort latest first
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      if (pagination) {
        const start = pagination.offset || 0;
        const end = pagination.limit !== undefined ? start + pagination.limit : undefined;
        list = list.slice(start, end);
      }

      const enriched: Contribution[] = list.map((c) => {
        const files = data.contribution_files.filter((cf) => cf.contribution_id === c.id);
        const task = c.task_id ? data.tasks.find((t) => t.id === c.task_id) || null : null;
        return {
          ...c,
          files,
          task,
        };
      });

      return { result: enriched };
    });
  }

  async getContributionById(contributionId: string): Promise<Contribution | null> {
    return this.withLock(async (data) => {
      const contribution = data.contributions.find((c) => c.id === contributionId);
      if (!contribution) return { result: null };

      const files = data.contribution_files.filter((cf) => cf.contribution_id === contributionId);
      const task = contribution.task_id ? data.tasks.find((t) => t.id === contribution.task_id) || null : null;

      return {
        result: {
          ...contribution,
          files,
          task,
        },
      };
    });
  }

  async getContributionFileById(fileId: string): Promise<ContributionFile | null> {
    return this.withLock(async (data) => {
      const file = data.contribution_files.find((cf) => cf.id === fileId);
      return { result: file ? { ...file } : null };
    });
  }

  // --- Common Development Workspace Operations ---
  async getWorkspaceTree(projectId: string): Promise<WorkspaceTreeItem[]> {
    return this.withLock(async (data) => {
      const nodes = (data.workspace_nodes || []).filter((n) => n.project_id === projectId && !n.deleted_at);

      // Build hierarchical tree
      const nodeMap = new Map<string, WorkspaceTreeItem>();
      nodes.forEach((n) => {
        nodeMap.set(n.id, { ...n, children: n.type === 'folder' ? [] : undefined });
      });

      const roots: WorkspaceTreeItem[] = [];

      nodes.forEach((n) => {
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

      // Sort: folders first, then alphabetical
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
      return { result: roots };
    });
  }

  async getWorkspaceNode(nodeId: string): Promise<WorkspaceNode | null> {
    return this.withLock(async (data) => {
      const node = (data.workspace_nodes || []).find((n) => n.id === nodeId && !n.deleted_at);
      return { result: node ? { ...node } : null };
    });
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
    return this.withLock(async (data) => {
      const isMember = (data.project_members || []).some(
        (pm) => pm.project_id === input.project_id && pm.user_id === input.author_id
      );
      if (!isMember) {
        throw new Error('Forbidden. Only project members can create workspace files or folders.');
      }

      const cleanName = input.name.trim();
      if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName.includes('/') || cleanName.includes('\\') || cleanName.includes('\0')) {
        throw new Error('Invalid file or folder name. Name cannot be empty or contain path separators.');
      }

      if (input.initialContent && Buffer.byteLength(input.initialContent, 'utf-8') > 10 * 1024 * 1024) {
        throw new Error('File content exceeds the maximum size limit of 10MB.');
      }

      let parentPath = '';
      if (input.parent_id) {
        const parent = (data.workspace_nodes || []).find(
          (n) => n.id === input.parent_id && n.project_id === input.project_id && !n.deleted_at
        );
        if (!parent || parent.type !== 'folder') {
          throw new Error('Parent folder not found or target is not a folder.');
        }
        parentPath = parent.path;
      }

      const nodePath = `${parentPath}/${cleanName}`;
      const duplicate = (data.workspace_nodes || []).some(
        (n) => n.project_id === input.project_id && n.path === nodePath && !n.deleted_at
      );
      if (duplicate) {
        throw new Error(`An item with path "${nodePath}" already exists in this project.`);
      }

      const now = new Date().toISOString();
      const nodeId = uuidv4();
      const initialContent = input.initialContent ?? '';
      const size = input.type === 'file' ? Buffer.byteLength(initialContent, 'utf-8') : undefined;

      const newNode: WorkspaceNode = {
        id: nodeId,
        project_id: input.project_id,
        parent_id: input.parent_id || null,
        name: cleanName,
        path: nodePath,
        type: input.type,
        current_revision: 1,
        last_modified_by: input.author_id,
        last_modified_name: input.author_name,
        created_at: now,
        updated_at: now,
        size,
      };

      data.workspace_nodes.push(newNode);

      if (input.type === 'file') {
        const checksum = crypto.createHash('sha256').update(initialContent).digest('hex');
        const initialRevision: WorkspaceRevision = {
          id: uuidv4(),
          node_id: nodeId,
          project_id: input.project_id,
          revision_number: 1,
          content: initialContent,
          author_id: input.author_id,
          author_name: input.author_name,
          checksum,
          created_at: now,
        };
        data.workspace_revisions.push(initialRevision);

        // Persist file snapshot on disk
        const projectDir = path.join(this.workspacesBaseDir, input.project_id);
        const diskPath = path.join(projectDir, nodePath.replace(/^\//, ''));
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, initialContent, 'utf-8');
      }

      return { result: { ...newNode }, dataToSave: data };
    });
  }

  async updateWorkspaceNode(
    nodeId: string,
    updates: { name?: string; parent_id?: string | null },
    author_id: string,
    author_name: string
  ): Promise<WorkspaceNode> {
    return this.withLock(async (data) => {
      const node = (data.workspace_nodes || []).find((n) => n.id === nodeId && !n.deleted_at);
      if (!node) throw new Error('Workspace item not found.');

      const isMember = (data.project_members || []).some(
        (pm) => pm.project_id === node.project_id && pm.user_id === author_id
      );
      if (!isMember) {
        throw new Error('Forbidden. Only project members can rename or move workspace items.');
      }

      const oldPath = node.path;
      let newName = node.name;
      let newParentId = node.parent_id;

      if (updates.name !== undefined) {
        newName = updates.name.trim();
        if (!newName || newName === '.' || newName === '..' || newName.includes('/') || newName.includes('\\') || newName.includes('\0')) {
          throw new Error('Invalid name. Cannot be empty or contain path separators.');
        }
      }

      if (updates.parent_id !== undefined) {
        newParentId = updates.parent_id;
      }

      let parentPath = '';
      if (newParentId) {
        // Prevent directory cycle: cannot move into self
        if (newParentId === nodeId) {
          throw new Error('Cannot move a folder into itself.');
        }

        const parent = (data.workspace_nodes || []).find(
          (n) => n.id === newParentId && !n.deleted_at
        );
        if (!parent || parent.project_id !== node.project_id || parent.type !== 'folder') {
          throw new Error('Target parent folder not found, belongs to another project, or is not a folder.');
        }

        // Prevent directory cycle: cannot move into one of its descendants
        if (node.type === 'folder') {
          if (parent.path === oldPath || parent.path.startsWith(`${oldPath}/`)) {
            throw new Error('Cannot move a folder into one of its descendants.');
          }

          let currParentId: string | null = parent.parent_id;
          while (currParentId) {
            if (currParentId === nodeId) {
              throw new Error('Cannot move a folder into one of its descendants.');
            }
            const ancestor = (data.workspace_nodes || []).find((n) => n.id === currParentId && !n.deleted_at);
            currParentId = ancestor?.parent_id || null;
          }
        }

        parentPath = parent.path;
      }

      const newPath = `${parentPath}/${newName}`;

      // Prevent duplicate paths in the project
      const duplicate = (data.workspace_nodes || []).some(
        (n) => n.project_id === node.project_id && n.id !== nodeId && n.path === newPath && !n.deleted_at
      );
      if (duplicate) {
        throw new Error(`An item with path "${newPath}" already exists in this project.`);
      }

      const now = new Date().toISOString();

      // Update current node
      node.name = newName;
      node.parent_id = newParentId || null;
      node.path = newPath;
      node.last_modified_by = author_id;
      node.last_modified_name = author_name;
      node.updated_at = now;

      // If folder, cascade prefix update to all descendants
      if (node.type === 'folder' && oldPath !== newPath) {
        const descendants = (data.workspace_nodes || []).filter(
          (n) => n.project_id === node.project_id && n.id !== node.id && !n.deleted_at && n.path.startsWith(`${oldPath}/`)
        );
        descendants.forEach((d) => {
          d.path = `${newPath}${d.path.slice(oldPath.length)}`;
          d.updated_at = now;
        });
      }

      // Persist disk rename if applicable
      try {
        const oldDiskPath = path.join(this.workspacesBaseDir, node.project_id, oldPath.replace(/^\//, ''));
        const newDiskPath = path.join(this.workspacesBaseDir, node.project_id, newPath.replace(/^\//, ''));
        if (fs.existsSync(oldDiskPath)) {
          fs.mkdirSync(path.dirname(newDiskPath), { recursive: true });
          fs.renameSync(oldDiskPath, newDiskPath);
        }
      } catch {
        // Disk move is best-effort
      }

      return { result: { ...node }, dataToSave: data };
    });
  }

  async deleteWorkspaceNode(nodeId: string): Promise<boolean> {
    return this.withLock(async (data) => {
      const target = (data.workspace_nodes || []).find((n) => n.id === nodeId && !n.deleted_at);
      if (!target) return { result: false };

      const targetPath = target.path;
      const projectId = target.project_id;
      const now = new Date().toISOString();

      // Identify target and all descendants if folder
      const nodeIdsToSoftDelete = new Set<string>();
      nodeIdsToSoftDelete.add(target.id);

      if (target.type === 'folder') {
        (data.workspace_nodes || []).forEach((n) => {
          if (n.project_id === projectId && !n.deleted_at && (n.path === targetPath || n.path.startsWith(`${targetPath}/`))) {
            nodeIdsToSoftDelete.add(n.id);
          }
        });
      }

      // Mark deleted_at on nodes without destroying recoverable revision history
      (data.workspace_nodes || []).forEach((n) => {
        if (nodeIdsToSoftDelete.has(n.id)) {
          n.deleted_at = now;
        }
      });

      // DO NOT delete workspace_revisions - history is preserved!

      // Clean disk representation if exists
      try {
        const diskPath = path.join(this.workspacesBaseDir, projectId, targetPath.replace(/^\//, ''));
        if (fs.existsSync(diskPath)) {
          fs.rmSync(diskPath, { recursive: true, force: true });
        }
      } catch {
        // Disk cleanup is best-effort
      }

      return { result: true, dataToSave: data };
    });
  }

  async getWorkspaceFile(fileId: string): Promise<WorkspaceFileDetail | null> {
    return this.withLock(async (data) => {
      const node = (data.workspace_nodes || []).find((n) => n.id === fileId && n.type === 'file' && !n.deleted_at);
      if (!node) return { result: null };

      // Find latest revision
      const revisions = (data.workspace_revisions || [])
        .filter((r) => r.node_id === fileId)
        .sort((a, b) => b.revision_number - a.revision_number);

      const latestRev = revisions[0];
      const content = latestRev ? latestRev.content : '';

      return {
        result: {
          ...node,
          content,
          revisions,
        },
      };
    });
  }

  async saveWorkspaceFile(
    fileId: string,
    content: string,
    baseRevision: number | undefined,
    author_id: string,
    author_name: string,
    forceOverwrite?: boolean
  ): Promise<{ file: WorkspaceFileDetail; conflict?: boolean; currentRevision?: number }> {
    return this.withLock<{ file: WorkspaceFileDetail; conflict: boolean; currentRevision?: number }>(async (data) => {
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

      const node = (data.workspace_nodes || []).find((n) => n.id === fileId && n.type === 'file' && !n.deleted_at);
      if (!node) throw new Error('Workspace file not found.');

      if (Buffer.byteLength(content, 'utf-8') > 10 * 1024 * 1024) {
        throw new Error('File content exceeds the maximum size limit of 10MB.');
      }

      const isMember = (data.project_members || []).some(
        (pm) => pm.project_id === node.project_id && pm.user_id === author_id
      );
      if (!isMember) {
        throw new Error('Forbidden. Only project members can edit workspace files.');
      }

      // CONFLICT DETECTION: Optimistic concurrency control (bypassed if forceOverwrite is true)
      if (!isForce && baseRevision !== undefined && node.current_revision !== baseRevision) {
        const latestRev = (data.workspace_revisions || [])
          .filter((r) => r.node_id === fileId)
          .sort((a, b) => b.revision_number - a.revision_number)[0];

        return {
          result: {
            file: {
              ...node,
              content: latestRev ? latestRev.content : '',
            },
            conflict: true,
            currentRevision: node.current_revision,
          },
        };
      }

      const nextRevNum = node.current_revision + 1;
      const now = new Date().toISOString();
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      node.current_revision = nextRevNum;
      node.last_modified_by = author_id;
      node.last_modified_name = author_name;
      node.updated_at = now;
      node.size = Buffer.byteLength(content, 'utf-8');

      const newRevision: WorkspaceRevision = {
        id: uuidv4(),
        node_id: fileId,
        project_id: node.project_id,
        revision_number: nextRevNum,
        content,
        author_id,
        author_name,
        checksum,
        created_at: now,
      };

      data.workspace_revisions.push(newRevision);

      // Persist to disk
      const projectDir = path.join(this.workspacesBaseDir, node.project_id);
      const diskPath = path.join(projectDir, node.path.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, content, 'utf-8');

      const revisions = (data.workspace_revisions || [])
        .filter((r) => r.node_id === fileId)
        .sort((a, b) => b.revision_number - a.revision_number);

      return {
        result: {
          file: {
            ...node,
            content,
            revisions,
          },
          conflict: false,
        },
        dataToSave: data,
      };
    });
  }

  async getWorkspaceFileRevisions(fileId: string, pagination?: PaginationOptions): Promise<WorkspaceRevision[]> {
    return this.withLock(async (data) => {
      let revisions = (data.workspace_revisions || [])
        .filter((r) => r.node_id === fileId)
        .sort((a, b) => b.revision_number - a.revision_number);

      if (pagination) {
        const start = pagination.offset || 0;
        const end = pagination.limit !== undefined ? start + pagination.limit : undefined;
        revisions = revisions.slice(start, end);
      }

      return { result: revisions };
    });
  }

  async restoreWorkspaceRevision(
    fileId: string,
    targetRevisionNumber: number,
    author_id: string,
    author_name: string,
    baseRevision?: number,
    forceOverwrite?: boolean
  ): Promise<WorkspaceFileDetail> {
    return this.withLock(async (data) => {
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

      const node = (data.workspace_nodes || []).find((n) => n.id === fileId && n.type === 'file' && !n.deleted_at);
      if (!node) throw new Error('Workspace file not found.');

      const isMember = (data.project_members || []).some(
        (pm) => pm.project_id === node.project_id && pm.user_id === author_id
      );
      if (!isMember) {
        throw new Error('Forbidden. Only project members can restore workspace files.');
      }

      // Concurrency check: Ensure no newer revision was saved unless forceOverwrite is enabled
      if (!isForce && baseRevision !== undefined && node.current_revision !== baseRevision) {
        throw new Error(
          `Conflict: File has been updated to revision ${node.current_revision} by another teammate.`
        );
      }

      const targetRev = (data.workspace_revisions || []).find(
        (r) => r.node_id === fileId && r.revision_number === targetRevisionNumber
      );
      if (!targetRev) {
        throw new Error(`Revision ${targetRevisionNumber} not found for this file.`);
      }

      // Restore as a brand new revision with target content
      const nextRevNum = node.current_revision + 1;
      const now = new Date().toISOString();
      const content = targetRev.content;
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      node.current_revision = nextRevNum;
      node.last_modified_by = author_id;
      node.last_modified_name = `${author_name} (Restored Rev #${targetRevisionNumber})`;
      node.updated_at = now;
      node.size = Buffer.byteLength(content, 'utf-8');

      const newRevision: WorkspaceRevision = {
        id: uuidv4(),
        node_id: fileId,
        project_id: node.project_id,
        revision_number: nextRevNum,
        content,
        author_id,
        author_name: `${author_name} (Restored Rev #${targetRevisionNumber})`,
        checksum,
        created_at: now,
      };

      data.workspace_revisions.push(newRevision);

      // Persist to disk
      const projectDir = path.join(this.workspacesBaseDir, node.project_id);
      const diskPath = path.join(projectDir, node.path.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, content, 'utf-8');

      const revisions = (data.workspace_revisions || [])
        .filter((r) => r.node_id === fileId)
        .sort((a, b) => b.revision_number - a.revision_number);

      return {
        result: {
          ...node,
          content,
          revisions,
        },
        dataToSave: data,
      };
    });
  }
}

