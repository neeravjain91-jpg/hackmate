'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ProjectNav } from '@/components/ProjectNav';
import { ProjectWithDetails, Task, TaskStatus } from '@/lib/types';
import {
  PlusCircle,
  Clock,
  User,
  CheckCircle2,
  AlertCircle,
  Filter,
  CheckSquare,
  ArrowRight,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';

export default function TasksPage({ params }: { params: { id: string } }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('ALL');

  // Create Task Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDeadline, setNewDeadline] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Action status loading
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Load project details
      const projRes = await fetch(`/api/projects/${params.id}`);
      if (projRes.status === 401) {
        router.push('/login');
        return;
      }
      if (projRes.status === 403) {
        setError('Forbidden. You do not belong to this project.');
        setLoading(false);
        return;
      }
      const projData = await projRes.json();
      setProject(projData.project);

      // Load tasks
      const tasksRes = await fetch(`/api/projects/${params.id}/tasks`);
      const tasksData = await tasksRes.json();
      setTasks(tasksData.tasks || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        router.push('/login');
      } else {
        loadData();
      }
    }
  }, [authLoading, user, router, loadData]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateSubmitting(true);

    try {
      const res = await fetch(`/api/projects/${params.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle,
          description: newDescription,
          assigned_to: newAssignee,
          deadline: newDeadline || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create task');

      setShowCreateModal(false);
      setNewTitle('');
      setNewDescription('');
      setNewAssignee('');
      setNewDeadline('');
      await loadData();
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleUpdateStatus = async (taskId: string, newStatus: TaskStatus) => {
    setActionLoadingId(taskId);
    try {
      const res = await fetch(`/api/projects/${params.id}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update task status');

      await loadData();
    } catch (err: any) {
      alert(`Error updating task: ${err.message}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-500 font-medium">Loading tasks...</p>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="max-w-xl mx-auto my-12 p-6 bg-white rounded-2xl border border-slate-200 text-center">
        <AlertCircle className="w-8 h-8 text-rose-600 mx-auto mb-2" />
        <h2 className="text-base font-bold text-slate-900">{error || 'Project not found.'}</h2>
      </div>
    );
  }

  const isLeader = project.currentUserRole === 'leader';

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter !== 'ALL' && t.status !== statusFilter) return false;
    if (assigneeFilter !== 'ALL' && t.assigned_to !== assigneeFilter) return false;
    return true;
  });

  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'Assigned':
        return <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">Assigned</span>;
      case 'In Progress':
        return <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">In Progress</span>;
      case 'Submitted':
        return <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 animate-pulse">Submitted (Needs Review)</span>;
      case 'Changes Requested':
        return <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">Changes Requested</span>;
      case 'Approved':
        return <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">✓ Approved</span>;
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <ProjectNav project={project} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6">
        {/* Header Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Task Assignments</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {isLeader
                ? 'As Team Leader, you can create tasks, assign teammates, and review completed work.'
                : 'View your assignments and update your progress for team review.'}
            </p>
          </div>

          {isLeader && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition shadow-sm"
            >
              <PlusCircle className="w-4 h-4" /> Create & Assign Task
            </button>
          )}
        </div>

        {/* Filters Bar */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <Filter className="w-3.5 h-3.5" /> Filters:
            </div>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="ALL">All Statuses ({tasks.length})</option>
              <option value="Assigned">Assigned</option>
              <option value="In Progress">In Progress</option>
              <option value="Submitted">Submitted (Review Needed)</option>
              <option value="Changes Requested">Changes Requested</option>
              <option value="Approved">Approved</option>
            </select>

            {/* Assignee Filter */}
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="ALL">All Assignees</option>
              {project.members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.user?.name} {m.user_id === user?.id ? '(You)' : ''}
                </option>
              ))}
            </select>
          </div>

          <span className="text-xs text-slate-500 font-medium">
            Showing {filteredTasks.length} of {tasks.length} tasks
          </span>
        </div>

        {/* Tasks List */}
        {filteredTasks.length === 0 ? (
          <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-sm">
            <CheckSquare className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-900">No tasks match your filter</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
              {tasks.length === 0
                ? isLeader
                  ? 'Get started by creating and distributing tasks to your teammates above.'
                  : 'No tasks have been assigned by the team leader yet.'
                : 'Try adjusting your filters above to see more tasks.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTasks.map((task) => {
              const isAssignedToMe = task.assigned_to === user?.id;
              const isActionLoading = actionLoadingId === task.id;

              return (
                <div
                  key={task.id}
                  className={`bg-white rounded-2xl border p-5 sm:p-6 transition shadow-sm ${
                    task.status === 'Submitted'
                      ? 'border-amber-300 ring-1 ring-amber-200'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="space-y-2 flex-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="text-base font-bold text-slate-900">{task.title}</h3>
                        {getStatusBadge(task.status)}
                      </div>

                      {task.description && (
                        <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                          {task.description}
                        </p>
                      )}

                      <div className="pt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                        <div className="flex items-center gap-1.5 font-medium">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>
                            Assignee: <strong className="text-slate-800">{task.assignee?.name || 'Unassigned'}</strong>
                            {isAssignedToMe && <span className="ml-1 text-emerald-600 font-bold">(You)</span>}
                          </span>
                        </div>

                        {task.deadline && (
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                            <span>Deadline: {new Date(task.deadline).toLocaleDateString()}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Contextual Action Buttons */}
                    <div className="flex flex-wrap items-center gap-2 pt-2 sm:pt-0 sm:border-l sm:border-slate-100 sm:pl-4">
                      {/* ASSIGNEE ACTIONS */}
                      {isAssignedToMe && task.status === 'Assigned' && (
                        <button
                          disabled={isActionLoading}
                          onClick={() => handleUpdateStatus(task.id, 'In Progress')}
                          className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold transition flex items-center gap-1.5"
                        >
                          Start Working (In Progress)
                        </button>
                      )}

                      {isAssignedToMe && (task.status === 'In Progress' || task.status === 'Changes Requested') && (
                        <button
                          disabled={isActionLoading}
                          onClick={() => handleUpdateStatus(task.id, 'Submitted')}
                          className="px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
                        >
                          Submit Work for Review
                        </button>
                      )}

                      {/* LEADER REVIEW ACTIONS */}
                      {isLeader && (
                        <div className="flex items-center gap-2">
                          {task.status !== 'Approved' && (
                            <button
                              disabled={isActionLoading}
                              onClick={() => handleUpdateStatus(task.id, 'Approved')}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                            </button>
                          )}

                          {task.status !== 'Changes Requested' && task.status !== 'Assigned' && (
                            <button
                              disabled={isActionLoading}
                              onClick={() => handleUpdateStatus(task.id, 'Changes Requested')}
                              className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs font-semibold transition flex items-center gap-1.5"
                            >
                              <RotateCcw className="w-3.5 h-3.5" /> Request Changes
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* CREATE TASK MODAL (Leader only) */}
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
            <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200">
              <h3 className="text-xl font-bold text-slate-900">Create & Assign New Task</h3>
              <p className="text-xs text-slate-600 mt-1">
                Distribute hackathon responsibilities to a specific teammate.
              </p>

              {createError && (
                <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                  {createError}
                </div>
              )}

              <form onSubmit={handleCreateTask} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Task Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Train PyTorch ML Classifier"
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Assign To *
                  </label>
                  <select
                    required
                    value={newAssignee}
                    onChange={(e) => setNewAssignee(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="">Select a team member...</option>
                    {project.members.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.user?.name} ({m.user?.email}) {m.role === 'leader' ? '— Leader' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Task Description & Acceptance Criteria
                  </label>
                  <textarea
                    rows={3}
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="Specify inputs, models, endpoints, or requirements expected..."
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Deadline (Optional)
                  </label>
                  <input
                    type="date"
                    value={newDeadline}
                    onChange={(e) => setNewDeadline(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="pt-2 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={createSubmitting}
                    className="px-5 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-60"
                  >
                    {createSubmitting ? 'Assigning...' : 'Assign Task'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
