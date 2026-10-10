'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ProjectNav } from '@/components/ProjectNav';
import { ProjectWithDetails, Contribution, Task } from '@/lib/types';
import {
  FolderArchive,
  UploadCloud,
  Search,
  Download,
  FileCode,
  FileText,
  Package,
  Calendar,
  User,
  CheckCircle2,
  Tag,
  Terminal,
  Paperclip,
  AlertCircle,
  Filter,
  Layers,
} from 'lucide-react';

export default function SharedWorkPage({ params }: { params: { id: string } }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [contributorFilter, setContributorFilter] = useState('ALL');
  const [taskFilter, setTaskFilter] = useState('ALL');

  // Publish Contribution Modal
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTaskId, setNewTaskId] = useState('');
  const [newVersionLabel, setNewVersionLabel] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [newDependencies, setNewDependencies] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [publishSubmitting, setPublishSubmitting] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Load project
      const projRes = await fetch(`/api/projects/${params.id}`);
      if (projRes.status === 401) {
        router.push('/login');
        return;
      }
      if (projRes.status === 403) {
        setError('Forbidden. You are not a member of this project.');
        setLoading(false);
        return;
      }
      const projData = await projRes.json();
      setProject(projData.project);

      // Load tasks (for association)
      const tasksRes = await fetch(`/api/projects/${params.id}/tasks`);
      const tasksData = await tasksRes.json();
      setTasks(tasksData.tasks || []);

      // Load contributions
      const contribsRes = await fetch(`/api/projects/${params.id}/contributions`);
      const contribsData = await contribsRes.json();
      setContributions(contribsData.contributions || []);
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

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishError(null);

    if (!selectedFiles || selectedFiles.length === 0) {
      setPublishError('Please attach at least one file to publish.');
      return;
    }

    setPublishSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('title', newTitle);
      formData.append('description', newDescription);
      if (newTaskId) formData.append('task_id', newTaskId);
      if (newVersionLabel) formData.append('version_label', newVersionLabel);
      formData.append('usage_instructions', newInstructions);
      formData.append('dependencies', newDependencies);

      for (let i = 0; i < selectedFiles.length; i++) {
        formData.append('files', selectedFiles[i]);
      }

      const res = await fetch(`/api/projects/${params.id}/contributions`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to publish contribution');

      setShowPublishModal(false);
      setNewTitle('');
      setNewDescription('');
      setNewTaskId('');
      setNewVersionLabel('');
      setNewInstructions('');
      setNewDependencies('');
      setSelectedFiles(null);
      await loadData();
    } catch (err: any) {
      setPublishError(err.message);
    } finally {
      setPublishSubmitting(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  if (authLoading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-500 font-medium">Loading Shared Work library...</p>
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

  const filteredContributions = contributions.filter((c) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const match =
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.contributor_name.toLowerCase().includes(q) ||
        (c.version_label && c.version_label.toLowerCase().includes(q)) ||
        c.files?.some((f) => f.file_name.toLowerCase().includes(q));
      if (!match) return false;
    }

    if (contributorFilter !== 'ALL' && c.contributor_id !== contributorFilter) {
      return false;
    }

    if (taskFilter !== 'ALL' && c.task_id !== taskFilter) {
      return false;
    }

    return true;
  });

  return (
    <div className="flex-1 flex flex-col">
      <ProjectNav project={project} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6">
        {/* Header Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Shared Work Library</h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                Core Feature
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-1 max-w-2xl">
              Publish trained models, inference scripts, datasets, frontend components, and backend endpoints so teammates can download and test work locally.
            </p>
          </div>

          <button
            onClick={() => setShowPublishModal(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition shadow-sm"
          >
            <UploadCloud className="w-4 h-4" /> Publish Contribution
          </button>
        </div>

        {/* Search & Filter Bar */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title, author, file, or version..."
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Filter className="w-3.5 h-3.5" /> Filters:
            </div>

            <select
              value={contributorFilter}
              onChange={(e) => setContributorFilter(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="ALL">All Contributors</option>
              {project.members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.user?.name}
                </option>
              ))}
            </select>

            <select
              value={taskFilter}
              onChange={(e) => setTaskFilter(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="ALL">All Associated Tasks</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  Task: {t.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Contributions List */}
        {filteredContributions.length === 0 ? (
          <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-sm">
            <FolderArchive className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-900">No contributions found</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
              {contributions.length === 0
                ? 'Your team library is currently empty. Click "Publish Contribution" to upload your scripts, models, or components.'
                : 'No contributions match your search or filter settings.'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {filteredContributions.map((contrib, idx) => (
              <div
                key={contrib.id}
                className="bg-white rounded-2xl border border-slate-200 hover:border-slate-300 transition shadow-sm overflow-hidden"
              >
                {/* Contribution Header */}
                <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h3 className="text-lg font-bold text-slate-900">{contrib.title}</h3>

                      {contrib.version_label && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                          <Tag className="w-3 h-3" /> {contrib.version_label}
                        </span>
                      )}

                      {idx === 0 && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase tracking-wider">
                          Latest Upload
                        </span>
                      )}
                    </div>

                    <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                      {contrib.description}
                    </p>

                    <div className="pt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                      <div className="flex items-center gap-1.5 font-medium">
                        <User className="w-3.5 h-3.5 text-slate-400" />
                        <span>
                          Contributor: <strong className="text-slate-800">{contrib.contributor_name}</strong>
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>Uploaded {new Date(contrib.created_at).toLocaleString()}</span>
                      </div>

                      {contrib.task && (
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Associated Task: <strong className="text-slate-800">{contrib.task.title}</strong></span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Technical Instructions & Dependencies Cards */}
                {(contrib.usage_instructions || contrib.dependencies) && (
                  <div className="bg-slate-50/70 p-5 border-b border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    {contrib.usage_instructions && (
                      <div className="space-y-1">
                        <span className="font-bold text-slate-700 flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5 text-slate-500" /> How to Run / Use
                        </span>
                        <div className="p-3 bg-white border border-slate-200 rounded-xl font-mono text-[11px] text-slate-800 overflow-x-auto whitespace-pre-wrap">
                          {contrib.usage_instructions}
                        </div>
                      </div>
                    )}

                    {contrib.dependencies && (
                      <div className="space-y-1">
                        <span className="font-bold text-slate-700 flex items-center gap-1.5">
                          <Package className="w-3.5 h-3.5 text-slate-500" /> Setup & Dependencies
                        </span>
                        <div className="p-3 bg-white border border-slate-200 rounded-xl font-mono text-[11px] text-slate-800 overflow-x-auto whitespace-pre-wrap">
                          {contrib.dependencies}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Attached Files List & Downloads */}
                <div className="p-5 bg-white">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <Paperclip className="w-3.5 h-3.5 text-slate-500" /> Attached Files ({contrib.files?.length || 0})
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {contrib.files?.map((file) => (
                      <div
                        key={file.id}
                        className="p-3 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-white hover:border-emerald-300 transition flex items-center justify-between gap-3 group"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center flex-shrink-0">
                            <FileCode className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 truncate" title={file.file_name}>
                              {file.file_name}
                            </p>
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              {formatFileSize(file.file_size)}
                            </p>
                          </div>
                        </div>

                        <a
                          href={`/api/projects/${project.id}/files/${file.id}/download`}
                          download={file.file_name}
                          className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 group-hover:border-emerald-500 group-hover:text-emerald-700 text-xs font-medium hover:bg-emerald-50 transition shadow-sm"
                          title="Download original file"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Get</span>
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* PUBLISH CONTRIBUTION MODAL */}
        {showPublishModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in overflow-y-auto">
            <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-xl border border-slate-200 my-8">
              <h3 className="text-xl font-bold text-slate-900">Publish Team Contribution</h3>
              <p className="text-xs text-slate-600 mt-1">
                Upload your code, models, or datasets so all teammates can access and run them.
              </p>

              {publishError && (
                <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                  {publishError}
                </div>
              )}

              <form onSubmit={handlePublish} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Contribution Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Trained ResNet Model & Inference Pipeline"
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      Version Label (Optional)
                    </label>
                    <input
                      type="text"
                      value={newVersionLabel}
                      onChange={(e) => setNewVersionLabel(e.target.value)}
                      placeholder="e.g. v1.0.0 or epoch-50"
                      className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      Associated Task (Optional)
                    </label>
                    <select
                      value={newTaskId}
                      onChange={(e) => setNewTaskId(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="">None (Standalone Work)</option>
                      {tasks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title} ({t.status})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Description of Work *
                  </label>
                  <textarea
                    rows={2}
                    required
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="Explain what this contribution provides and what problems it solves..."
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Usage Instructions / Execution Steps
                  </label>
                  <textarea
                    rows={2}
                    value={newInstructions}
                    onChange={(e) => setNewInstructions(e.target.value)}
                    placeholder="e.g. python inference.py --input sample.png"
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Dependencies & Environment Setup
                  </label>
                  <input
                    type="text"
                    value={newDependencies}
                    onChange={(e) => setNewDependencies(e.target.value)}
                    placeholder="e.g. Python 3.10+, torch>=2.0.0, CUDA 12"
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Upload Files (Max 50MB per file) *
                  </label>
                  <input
                    type="file"
                    multiple
                    required
                    onChange={(e) => setSelectedFiles(e.target.files)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
                  />
                  {selectedFiles && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {selectedFiles.length} file(s) selected
                    </p>
                  )}
                </div>

                <div className="pt-2 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowPublishModal(false)}
                    className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={publishSubmitting}
                    className="px-5 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-60"
                  >
                    {publishSubmitting ? 'Uploading...' : 'Publish to Team'}
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
