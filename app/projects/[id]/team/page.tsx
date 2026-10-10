'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ProjectNav } from '@/components/ProjectNav';
import { ProjectWithDetails } from '@/lib/types';
import {
  Users,
  Award,
  Copy,
  Check,
  ShieldCheck,
  AlertCircle,
  UserCheck,
  Share2,
  Calendar,
  Lock,
} from 'lucide-react';

export default function TeamManagementPage({ params }: { params: { id: string } }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

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

  const copyCode = () => {
    if (project?.invite_code) {
      navigator.clipboard.writeText(project.invite_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const copyInviteLink = () => {
    if (project?.invite_code) {
      const link = `${window.location.origin}/join?code=${project.invite_code}`;
      navigator.clipboard.writeText(link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-500 font-medium">Loading team members...</p>
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
  const isFull = project.memberCount >= 6;

  return (
    <div className="flex-1 flex flex-col">
      <ProjectNav project={project} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-8">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Team Roster & Invitations</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Strict 4–6 hackathon team structure. A project accommodates 1 leader and up to 5 teammates.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${
                isFull
                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                  : 'bg-emerald-50 text-emerald-800 border-emerald-200'
              }`}
            >
              {isFull ? 'Team is Full (6 / 6)' : `${6 - project.memberCount} Seat(s) Remaining`}
            </span>
          </div>
        </div>

        {/* INVITATION CONTROLS (Available to Leader & Members) */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Share2 className="w-5 h-5 text-emerald-600" />
            <h3 className="font-bold text-slate-900 text-base">Invite Teammates</h3>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
            Teammates can join by either navigating to the shareable invitation URL or entering the 8-character invitation code on their dashboard. Concurrent join attempts are automatically guarded against exceeding the 6-member limit.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            {/* Invite Code Box */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-4">
              <div>
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Invitation Code
                </span>
                <code className="text-lg font-mono font-bold text-slate-900 tracking-widest">
                  {project.invite_code}
                </code>
              </div>

              <button
                onClick={copyCode}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition shadow-sm"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
              </button>
            </div>

            {/* Shareable Link Box */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Direct Invitation Link
                </span>
                <span className="text-xs font-mono text-slate-600 truncate block">
                  /join?code={project.invite_code}
                </span>
              </div>

              <button
                onClick={copyInviteLink}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition shadow-sm flex-shrink-0"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                <span>{copiedLink ? 'Link Copied' : 'Copy Link'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Members Roster Table */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-slate-700" />
              <h3 className="font-bold text-slate-900 text-base">Project Members ({project.members.length} of 6)</h3>
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {project.members.map((member) => (
              <div
                key={member.id}
                className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-sm">
                    {member.user?.name?.charAt(0).toUpperCase() || 'U'}
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{member.user?.name || 'User'}</span>
                      {member.user_id === user?.id && (
                        <span className="text-xs font-semibold text-emerald-600">(You)</span>
                      )}
                    </div>
                    <span className="text-xs text-slate-500">{member.user?.email}</span>
                  </div>
                </div>

                <div className="flex items-center gap-6 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    <span>Joined {new Date(member.joined_at).toLocaleDateString()}</span>
                  </div>

                  {member.role === 'leader' ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                      <Award className="w-3.5 h-3.5" /> Team Leader
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
                      <UserCheck className="w-3.5 h-3.5 text-slate-500" /> Member
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
