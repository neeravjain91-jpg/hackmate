// ==============================================================================
// HACKMATE: Core Domain Types
// ==============================================================================

export type ProjectRole = 'leader' | 'member';

export type TaskStatus =
  | 'Assigned'
  | 'In Progress'
  | 'Submitted'
  | 'Changes Requested'
  | 'Approved';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar_url?: string | null;
  created_at: string;
}

export interface UserAuthRecord extends UserProfile {
  password_hash?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  hackathon_name?: string | null;
  invite_code: string;
  leader_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  joined_at: string;
  user?: UserProfile;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  assigned_to: string;
  created_by: string;
  status: TaskStatus;
  deadline?: string | null;
  created_at: string;
  updated_at: string;
  assignee?: UserProfile;
  creator?: UserProfile;
}

export interface ContributionFile {
  id: string;
  contribution_id: string;
  project_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  checksum: string;
  uploaded_at: string;
}

export interface Contribution {
  id: string;
  project_id: string;
  title: string;
  description: string;
  contributor_id: string;
  contributor_name: string;
  task_id?: string | null;
  version_label?: string | null;
  usage_instructions: string;
  dependencies: string;
  created_at: string;
  updated_at: string;
  files?: ContributionFile[];
  task?: Task | null;
}

export interface ProjectWithDetails extends Project {
  members: ProjectMember[];
  memberCount: number;
  currentUserRole?: ProjectRole;
  tasksCount?: number;
  contributionsCount?: number;
}
