'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from './AuthProvider';
import { Layers, LogOut, User } from 'lucide-react';

export function Navbar() {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 bg-white border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2.5 group">
              <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center text-white shadow-sm group-hover:bg-emerald-700 transition">
                <Layers className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-slate-900 text-lg leading-tight tracking-tight">HackMate</span>
                <span className="text-[10px] text-emerald-600 font-semibold uppercase tracking-wider">Team Collaboration</span>
              </div>
            </Link>

            {user && (
              <nav className="hidden md:flex items-center gap-4 text-sm font-medium text-slate-600">
                <Link
                  href="/dashboard"
                  className="px-3 py-1.5 rounded-md hover:text-slate-900 hover:bg-slate-100 transition"
                >
                  Dashboard
                </Link>
              </nav>
            )}
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-semibold text-slate-900 leading-tight">{user.name}</span>
                    <span className="text-[11px] text-slate-500 leading-tight truncate max-w-[140px]">{user.email}</span>
                  </div>
                </div>

                <button
                  onClick={() => logout()}
                  title="Sign out"
                  className="p-2 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="text-sm font-medium text-slate-700 hover:text-slate-900 px-3 py-1.5 rounded-md hover:bg-slate-100 transition"
                >
                  Log in
                </Link>
                <Link
                  href="/register"
                  className="text-sm font-medium bg-emerald-600 text-white px-3.5 py-1.5 rounded-lg hover:bg-emerald-700 shadow-sm transition"
                >
                  Sign up
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
