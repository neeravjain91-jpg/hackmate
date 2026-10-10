'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ProjectNav } from '@/components/ProjectNav';
import { ProjectWithDetails, Task, Contribution } from '@/lib/types';
import {
  Users,
  CheckSquare,
  FolderArchive,
  Copy,
  Check,
  Award,
  Clock,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  FileCode,
} from 'lucide-react';

export default function ProjectOverviewPage({ params }: { params: { id: string } }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

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
        setError('You do not belong to this project and cannot access its details.');
        setLoading(false);
        return;
      }
      const projData = await projRes.json();
      if (!projRes.ok) throw new Error(projData.error || 'Failed to load project');
      setProject(projData.project);

      // Load tasks
      const tasksRes = await fetch(`/api/projects/${params.id}/tasks`);
      if (tasksRes.ok) {
        const tasksData = await tasksRes.json();
        setTasks(tasksData.tasks || []);
      }

      // Load contributions
      const contribsRes = await fetch(`/api/projects/${params.id}/contributions`);
      if (contribsRes.ok) {
        const contribsData = await contribsRes.json();
        setContributions(contribsData.contributions || []);
      }
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

  const copyInvite = () => {
    if (project?.invite_code) {
      navigator.clipboard.writeText(project.invite_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-500 font-medium">Loading project overview...</p>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="max-w-xl mx-auto my-12 p-6 bg-white rounded-2xl border border-slate-200 shadow-sm text-center">
        <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-xl flex items-center justify-center mx-auto mb-3">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">Access Denied or Not Found</h2>
        <p className="text-sm text-slate-600 mt-2">{error || 'Project could not be found.'}</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const statusCounts = {
    Assigned: tasks.filter((t) => t.status === 'Assigned').length,
    'In Progress': tasks.filter((t) => t.status === 'In Progress').length,
    Submitted: tasks.filter((t) => t.status === 'Submitted').length,
    'Changes Requested': tasks.filter((t) => t.status === 'Changes Requested').length,
    Approved: tasks.filter((t) => t.status === 'Approved').length,
  };

  return (
    <div className="flex-1 flex flex-col">
      <ProjectNav project={project} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-8">
        {/* Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Team Capacity</span>
              <Users className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">{project.memberCount} / 6</span>
              <span className="text-xs text-slate-500">members</span>
            </div>
            <div className="mt-3 w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-500 h-full rounded-full transition-all"
                style={{ width: `${(project.memberCount / 6) * 100}%` }}
              ></div>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Tasks</span>
              <CheckSquare className="w-4 h-4 text-blue-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">{tasks.length}</span>
              <span className="text-xs text-emerald-600 font-semibold">{statusCounts.Approved} approved</span>
            </div>
            <div className="mt-3 text-xs text-slate-500 flex items-center gap-1">
              <span>{statusCounts.Submitted} pending review</span>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Shared Library</span>
              <FolderArchive className="w-4 h-4 text-purple-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">{contributions.length}</span>
              <span className="text-xs text-slate-500">contributions</span>
            </div>
            <div className="mt-3 text-xs text-slate-500">
              <span>Ready for team download</span>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Invite Code</span>
              <ShieldCheck className="w-4 h-4 text-amber-600" />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <code className="text-lg font-mono font-bold text-slate-900 tracking-wider">
                {project.invite_code}
              </code>
              <button
                onClick={copyInvite}
                title="Copy Invite Code"
                className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
              >
                {copiedCode ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Share with up to {6 - project.memberCount} more teammates</p>
          </div>
        </div>

        {/* Two-Column Grid: Team Members & Tasks Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Team Members List */}
          <div className="lg:col-span-1 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">Team Roster</h3>
              <Link href={`/projects/${project.id}/team`} className="text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                Manage
              </Link>
            </div>

            <div className="divide-y divide-slate-100">
              {project.members.map((member) => (
                <div key={member.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs">
                      {member.user?.name?.charAt(0).toUpperCase() || 'U'}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900 leading-tight">{member.user?.name || 'User'}</p>
                      <p className="text-xs text-slate-500 leading-tight truncate max-w-[150px]">{member.user?.email}</p>
                    </div>
                  </div>

                  {member.role === 'leader' ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
                      <Award className="w-3 h-3" /> Leader
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      Member
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Task Pipeline Summary */}
          <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">Task Distribution & Status</h3>
              <Link
                href={`/projects/${project.id}/tasks`}
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700"
              >
                Go to Tasks <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-center">
                <span className="text-xs text-slate-500 font-medium">Assigned</span>
                <p className="text-xl font-bold text-slate-800 mt-1">{statusCounts.Assigned}</p>
              </div>
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-center">
                <span className="text-xs text-blue-700 font-medium">In Progress</span>
                <p className="text-xl font-bold text-blue-900 mt-1">{statusCounts['In Progress']}</p>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-center">
                <span className="text-xs text-amber-700 font-medium">Submitted</span>
                <p className="text-xl font-bold text-amber-900 mt-1">{statusCounts.Submitted}</p>
              </div>
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-center">
                <span className="text-xs text-rose-700 font-medium">Changes Req</span>
                <p className="text-xl font-bold text-rose-900 mt-1">{statusCounts['Changes Requested']}</p>
              </div>
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-center">
                <span className="text-xs text-emerald-700 font-medium">Approved</span>
                <p className="text-xl font-bold text-emerald-900 mt-1">{statusCounts.Approved}</p>
              </div>
            </div>

            {/* Recent Contributions Preview */}
            <div className="pt-6 border-t border-slate-100">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-slate-900">Latest Shared Work</h4>
                <Link
                  href={`/projects/${project.id}/shared-work`}
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                >
                  View Library ({contributions.length})
                </Link>
              </div>

              {contributions.length === 0 ? (
                <div className="p-6 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50">
                  <FileCode className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-xs text-slate-500">No contributions published yet.</p>
                  <Link
                    href={`/projects/${project.id}/shared-work`}
                    className="mt-2 inline-block text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                  >
                    Publish the first contribution →
                  </Link>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {contributions.slice(0, 3).map((c) => (
                    <div
                      key={c.id}
                      className="p-3 rounded-xl border border-slate-200 hover:border-slate-300 transition flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-slate-900">{c.title}</span>
                          {c.version_label && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-50 text-purple-700 border border-purple-200">
                              {c.version_label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">By {c.contributor_name} • {c.files?.length || 0} files</p>
                      </div>

                      <Link
                        href={`/projects/${project.id}/shared-work`}
                        className="text-xs font-medium text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded bg-emerald-50"
                      >
                        Download Files
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
