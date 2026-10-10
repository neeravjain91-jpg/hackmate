'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, CheckSquare, FolderArchive, Users, ShieldAlert, Award, Code } from 'lucide-react';
import { ProjectWithDetails } from '@/lib/types';

interface ProjectNavProps {
  project: ProjectWithDetails;
}

export function ProjectNav({ project }: ProjectNavProps) {
  const pathname = usePathname();
  const basePath = `/projects/${project.id}`;

  const tabs = [
    {
      name: 'Overview',
      href: basePath,
      exact: true,
      icon: LayoutDashboard,
    },
    {
      name: 'Workspace',
      href: `${basePath}/workspace`,
      icon: Code,
    },
    {
      name: 'Tasks',
      href: `${basePath}/tasks`,
      badge: project.tasksCount,
      icon: CheckSquare,
    },
    {
      name: 'Shared Work',
      href: `${basePath}/shared-work`,
      badge: project.contributionsCount,
      highlight: true,
      icon: FolderArchive,
    },
    {
      name: 'Team',
      href: `${basePath}/team`,
      badge: `${project.memberCount}/6`,
      icon: Users,
    },
  ];

  return (
    <div className="bg-white border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Project Header Info */}
        <div className="pt-6 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{project.name}</h1>
              {project.currentUserRole === 'leader' ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                  <Award className="w-3 h-3" /> Team Leader
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Member
                </span>
              )}
              {project.hackathon_name && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
                  🏆 {project.hackathon_name}
                </span>
              )}
            </div>
            {project.description && (
              <p className="mt-1 text-sm text-slate-600 max-w-3xl line-clamp-2">{project.description}</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
              <span className="text-slate-500 font-medium">Team:</span>
              <span className="font-bold text-slate-900">{project.memberCount} of 6 max</span>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="flex space-x-1 sm:space-x-4 border-t border-slate-100 pt-1 -mb-px overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.exact ? pathname === tab.href : pathname?.startsWith(tab.href);
            const Icon = tab.icon;

            return (
              <Link
                key={tab.name}
                href={tab.href}
                className={`flex items-center gap-2 py-3 px-3 sm:px-4 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                  isActive
                    ? 'border-emerald-600 text-emerald-700 font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-600' : 'text-slate-400'}`} />
                <span>{tab.name}</span>
                {tab.badge !== undefined && (
                  <span
                    className={`ml-1 px-1.5 py-0.5 text-xs rounded-full font-medium ${
                      isActive
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
                {tab.highlight && !isActive && (
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title="Core shared work library" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
