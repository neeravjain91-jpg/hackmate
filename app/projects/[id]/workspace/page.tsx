'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { ProjectNav } from '@/components/ProjectNav';
import {
  ProjectWithDetails,
  WorkspaceTreeItem,
  WorkspaceNode,
  WorkspaceFileDetail,
  WorkspaceRevision,
} from '@/lib/types';
import {
  FileCode,
  Folder,
  FolderOpen,
  Plus,
  FilePlus,
  FolderPlus,
  Trash2,
  Edit2,
  Save,
  RotateCcw,
  History,
  CheckCircle2,
  AlertTriangle,
  Clock,
  User,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  X,
  AlertCircle,
  FileText,
  FileJson,
  Layers,
} from 'lucide-react';

export default function WorkspacePage({ params }: { params: { id: string } }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [tree, setTree] = useState<WorkspaceTreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active open file state
  const [activeFile, setActiveFile] = useState<WorkspaceFileDetail | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [baseRevision, setBaseRevision] = useState<number>(1);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving' | 'conflict'>('saved');
  const [loadingFile, setLoadingFile] = useState<boolean>(false);

  // Folder expanded state
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  // Modals state
  const [showNewModal, setShowNewModal] = useState<boolean>(false);
  const [newType, setNewType] = useState<'file' | 'folder'>('file');
  const [newName, setNewName] = useState<string>('');
  const [newParentId, setNewParentId] = useState<string>('');
  const [newInitialContent, setNewInitialContent] = useState<string>('');
  const [createSubmitting, setCreateSubmitting] = useState<boolean>(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Rename modal
  const [renamingNode, setRenamingNode] = useState<WorkspaceNode | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');

  // History / Revision Drawer
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<WorkspaceRevision[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState<boolean>(false);
  const [previewRevision, setPreviewRevision] = useState<WorkspaceRevision | null>(null);

  // Conflict modal
  const [conflictData, setConflictData] = useState<{
    currentRevision: number;
    remoteContent: string;
    remoteAuthor: string;
  } | null>(null);

  // Load project & tree
  const loadWorkspace = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const projRes = await fetch(`/api/projects/${params.id}`);
      if (projRes.status === 401) {
        router.push('/login');
        return;
      }
      if (projRes.status === 403) {
        setError('Forbidden. You do not have access to this project workspace.');
        setLoading(false);
        return;
      }
      const projData = await projRes.json();
      setProject(projData.project);

      const treeRes = await fetch(`/api/projects/${params.id}/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        setTree(treeData.tree || []);

        // Auto-expand top folders by default
        const initExpanded: Record<string, boolean> = {};
        (treeData.tree || []).forEach((item: WorkspaceTreeItem) => {
          if (item.type === 'folder') initExpanded[item.id] = true;
        });
        setExpandedFolders((prev) => ({ ...initExpanded, ...prev }));
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
        loadWorkspace();
      }
    }
  }, [authLoading, user, router, loadWorkspace]);

  // Open file
  const handleOpenFile = async (fileId: string) => {
    if (isDirty && activeFile) {
      const confirmDiscard = window.confirm(
        'You have unsaved changes in the current file. Discard changes and switch files?'
      );
      if (!confirmDiscard) return;
    }

    try {
      setLoadingFile(true);
      setPreviewRevision(null);
      const res = await fetch(`/api/projects/${params.id}/workspace/files/${fileId}`);
      if (!res.ok) throw new Error('Failed to load file');
      const data = await res.json();
      setActiveFile(data.file);
      setFileContent(data.file.content);
      setBaseRevision(data.file.current_revision);
      setIsDirty(false);
      setSaveStatus('saved');
    } catch (err: any) {
      alert(`Error loading file: ${err.message}`);
    } finally {
      setLoadingFile(false);
    }
  };

  // Save file
  const handleSave = async (forceOverwrite = false) => {
    if (!activeFile) return;

    setSaveStatus('saving');

    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/files/${activeFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: fileContent,
          baseRevision: forceOverwrite ? undefined : baseRevision,
        }),
      });

      const data = await res.json();

      if (res.status === 409 && data.conflict) {
        setSaveStatus('conflict');
        setConflictData({
          currentRevision: data.currentRevision,
          remoteContent: data.file.content,
          remoteAuthor: data.file.last_modified_name,
        });
        return;
      }

      if (!res.ok) throw new Error(data.error || 'Failed to save file');

      setActiveFile(data.file);
      setBaseRevision(data.file.current_revision);
      setIsDirty(false);
      setSaveStatus('saved');
      setConflictData(null);

      // Refresh file tree to update sizes/timestamps
      const treeRes = await fetch(`/api/projects/${params.id}/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        setTree(treeData.tree || []);
      }
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
      setSaveStatus(isDirty ? 'unsaved' : 'saved');
    }
  };

  // Keyboard shortcut Ctrl+S / Cmd+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activeFile && isDirty) {
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFile, isDirty, fileContent, baseRevision]);

  // Handle Tab key in editor
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = fileContent.substring(0, start) + '  ' + fileContent.substring(end);
      setFileContent(newValue);
      setIsDirty(true);
      setSaveStatus('unsaved');
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  // Load revisions
  const handleOpenHistory = async () => {
    if (!activeFile) return;
    setShowHistory(true);
    setLoadingRevisions(true);
    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/files/${activeFile.id}/revisions`);
      if (res.ok) {
        const data = await res.json();
        setRevisions(data.revisions || []);
      }
    } finally {
      setLoadingRevisions(false);
    }
  };

  // Restore revision
  const handleRestoreRevision = async (revNum: number) => {
    if (!activeFile) return;
    const confirmRestore = window.confirm(
      `Restore Revision #${revNum}? This will create a new current revision with that content.`
    );
    if (!confirmRestore) return;

    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/files/${activeFile.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionNumber: revNum, baseRevision: activeFile.current_revision }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setSaveStatus('conflict');
          alert(data.error || 'Conflict detected: The file has been modified by another teammate.');
          await handleOpenFile(activeFile.id);
          return;
        }
        throw new Error(data.error || 'Failed to restore revision');
      }

      setActiveFile(data.file);
      setFileContent(data.file.content);
      setBaseRevision(data.file.current_revision);
      setIsDirty(false);
      setSaveStatus('saved');
      setPreviewRevision(null);
      await handleOpenHistory();
    } catch (err: any) {
      alert(`Error restoring revision: ${err.message}`);
    }
  };

  // Create Node (File / Folder)
  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateSubmitting(true);

    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          parent_id: newParentId || null,
          type: newType,
          initialContent: newInitialContent,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create item');

      setShowNewModal(false);
      setNewName('');
      setNewInitialContent('');

      // Refresh tree
      const treeRes = await fetch(`/api/projects/${params.id}/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        setTree(treeData.tree || []);
      }

      // If created a file, open it directly
      if (data.node.type === 'file') {
        await handleOpenFile(data.node.id);
      }
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Delete Node
  const handleDeleteNode = async (node: WorkspaceNode) => {
    const confirmDelete = window.confirm(
      `Delete "${node.name}"${node.type === 'folder' ? ' and all its contents' : ''}? This cannot be undone.`
    );
    if (!confirmDelete) return;

    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/nodes/${node.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete item');

      if (activeFile?.id === node.id) {
        setActiveFile(null);
        setFileContent('');
      }

      // Refresh tree
      const treeRes = await fetch(`/api/projects/${params.id}/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        setTree(treeData.tree || []);
      }
    } catch (err: any) {
      alert(`Error deleting: ${err.message}`);
    }
  };

  // Rename Node
  const handleRenameNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingNode) return;

    try {
      const res = await fetch(`/api/projects/${params.id}/workspace/nodes/${renamingNode.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue }),
      });
      if (!res.ok) throw new Error('Failed to rename item');

      setRenamingNode(null);

      // Refresh tree
      const treeRes = await fetch(`/api/projects/${params.id}/workspace/tree`);
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        setTree(treeData.tree || []);
      }

      if (activeFile?.id === renamingNode.id) {
        await handleOpenFile(activeFile.id);
      }
    } catch (err: any) {
      alert(`Error renaming: ${err.message}`);
    }
  };

  const getFileIcon = (fileName: string) => {
    if (fileName.endsWith('.py')) return <span className="text-yellow-600 font-bold text-[10px]">PY</span>;
    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) return <span className="text-blue-600 font-bold text-[10px]">TS</span>;
    if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) return <span className="text-amber-500 font-bold text-[10px]">JS</span>;
    if (fileName.endsWith('.json')) return <span className="text-emerald-600 font-bold text-[10px]">{`{ }`}</span>;
    if (fileName.endsWith('.md')) return <span className="text-slate-600 font-bold text-[10px]">MD</span>;
    return <FileCode className="w-3.5 h-3.5 text-slate-500" />;
  };

  // Render tree item recursively
  const renderTreeItem = (item: WorkspaceTreeItem, depth = 0) => {
    const isFolder = item.type === 'folder';
    const isExpanded = expandedFolders[item.id] ?? false;
    const isActive = activeFile?.id === item.id;

    return (
      <div key={item.id} className="select-none text-xs">
        <div
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          className={`flex items-center justify-between py-1.5 pr-2 rounded-lg cursor-pointer group transition ${
            isActive
              ? 'bg-emerald-50 text-emerald-900 font-semibold'
              : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
          }`}
          onClick={() => {
            if (isFolder) {
              setExpandedFolders((prev) => ({ ...prev, [item.id]: !isExpanded }));
            } else {
              handleOpenFile(item.id);
            }
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {isFolder ? (
              <>
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                )}
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Folder className="w-4 h-4 text-slate-500" />
                )}
              </>
            ) : (
              <span className="w-4 flex items-center justify-center flex-shrink-0">
                {getFileIcon(item.name)}
              </span>
            )}
            <span className="truncate" title={item.path}>
              {item.name}
            </span>
          </div>

          <div className="hidden group-hover:flex items-center gap-1">
            {isFolder && (
              <button
                title="Create file in folder"
                onClick={(e) => {
                  e.stopPropagation();
                  setNewParentId(item.id);
                  setNewType('file');
                  setShowNewModal(true);
                }}
                className="p-1 hover:text-emerald-700 hover:bg-slate-200 rounded"
              >
                <Plus className="w-3 h-3" />
              </button>
            )}
            <button
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setRenamingNode(item);
                setRenameValue(item.name);
              }}
              className="p-1 hover:text-slate-900 hover:bg-slate-200 rounded"
            >
              <Edit2 className="w-3 h-3 text-slate-400" />
            </button>
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteNode(item);
              }}
              className="p-1 hover:text-rose-600 hover:bg-rose-50 rounded"
            >
              <Trash2 className="w-3 h-3 text-slate-400 hover:text-rose-600" />
            </button>
          </div>
        </div>

        {isFolder && isExpanded && item.children && (
          <div>
            {item.children.length === 0 ? (
              <div
                style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
                className="py-1 text-[11px] text-slate-400 italic"
              >
                (Empty folder)
              </div>
            ) : (
              item.children.map((child) => renderTreeItem(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  if (authLoading || loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-500 font-medium">Loading development workspace...</p>
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

  const lineCount = fileContent.split('\n').length;

  return (
    <div className="flex-1 flex flex-col h-full min-h-[calc(100vh-64px)]">
      <ProjectNav project={project} />

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden bg-slate-100 border-b border-slate-200">
        {/* LEFT PANEL: FILE TREE */}
        <div className="w-full md:w-64 lg:w-72 bg-white border-r border-slate-200 flex flex-col flex-shrink-0 h-[350px] md:h-auto">
          {/* Tree Header */}
          <div className="p-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-600" /> Project Files
            </span>

            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setNewParentId('');
                  setNewType('file');
                  setShowNewModal(true);
                }}
                title="New File"
                className="p-1.5 rounded-md hover:bg-slate-200 text-slate-600 transition"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  setNewParentId('');
                  setNewType('folder');
                  setShowNewModal(true);
                }}
                title="New Folder"
                className="p-1.5 rounded-md hover:bg-slate-200 text-slate-600 transition"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={loadWorkspace}
                title="Refresh Tree"
                className="p-1.5 rounded-md hover:bg-slate-200 text-slate-600 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Tree Nodes List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {tree.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                <p>Workspace is empty.</p>
                <button
                  onClick={() => {
                    setNewParentId('');
                    setNewType('file');
                    setShowNewModal(true);
                  }}
                  className="mt-2 text-emerald-600 font-semibold hover:underline"
                >
                  Create first file →
                </button>
              </div>
            ) : (
              tree.map((item) => renderTreeItem(item))
            )}
          </div>
        </div>

        {/* CENTER PANEL: CODE & TEXT EDITOR */}
        <div className="flex-1 flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
          {activeFile ? (
            <>
              {/* Editor Header Bar */}
              <div className="bg-slate-800 border-b border-slate-700 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-white truncate">
                        {activeFile.name}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400 truncate hidden sm:inline">
                        ({activeFile.path})
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 truncate">
                      Last edited by {activeFile.last_modified_name} •{' '}
                      {new Date(activeFile.updated_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>

                {/* Status Badges & Action Buttons */}
                <div className="flex items-center gap-2.5">
                  {/* Save Status Indicator */}
                  {saveStatus === 'saving' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-900/50 text-blue-300 border border-blue-700">
                      <div className="w-2.5 h-2.5 border-2 border-blue-300 border-t-transparent rounded-full animate-spin"></div>
                      Saving...
                    </span>
                  )}
                  {saveStatus === 'unsaved' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-900/50 text-amber-300 border border-amber-700">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                      Unsaved changes
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      Saved
                    </span>
                  )}
                  {saveStatus === 'conflict' && (
                    <button
                      onClick={() => setConflictData(conflictData)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-900/60 text-rose-200 border border-rose-600 animate-bounce"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                      Conflict Detected
                    </button>
                  )}

                  {/* Revision Badge / History Trigger */}
                  <button
                    onClick={handleOpenHistory}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-mono font-medium transition"
                    title="View file revision history"
                  >
                    <History className="w-3.5 h-3.5 text-purple-400" />
                    <span>Rev #{activeFile.current_revision}</span>
                  </button>

                  {/* Save Button */}
                  <button
                    onClick={() => handleSave(false)}
                    disabled={!isDirty || saveStatus === 'saving'}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white text-xs font-bold transition shadow-sm"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save</span>
                  </button>
                </div>
              </div>

              {/* Preview Banner if inspecting historical revision */}
              {previewRevision && (
                <div className="bg-purple-900/70 border-b border-purple-700 px-4 py-2 flex items-center justify-between text-xs text-purple-200">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-purple-300" />
                    <span>
                      Previewing Historical Revision #{previewRevision.revision_number} by{' '}
                      <strong>{previewRevision.author_name}</strong> (
                      {new Date(previewRevision.created_at).toLocaleString()})
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRestoreRevision(previewRevision.revision_number)}
                      className="px-2.5 py-1 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 transition"
                    >
                      Restore This Version
                    </button>
                    <button
                      onClick={() => {
                        setPreviewRevision(null);
                        setFileContent(activeFile.content);
                      }}
                      className="px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
                    >
                      Exit Preview
                    </button>
                  </div>
                </div>
              )}

              {/* Editor Workspace Area */}
              <div className="flex-1 flex overflow-hidden relative">
                {/* Line Numbers Gutter */}
                <div className="w-12 bg-slate-950/70 border-r border-slate-800 py-4 select-none text-right pr-3 font-mono text-xs text-slate-600 flex-shrink-0 overflow-hidden">
                  {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                    <div key={i} className="leading-6">
                      {i + 1}
                    </div>
                  ))}
                </div>

                {/* Editor Textarea */}
                <textarea
                  value={fileContent}
                  onChange={(e) => {
                    setFileContent(e.target.value);
                    setIsDirty(true);
                    setSaveStatus('unsaved');
                  }}
                  onKeyDown={handleEditorKeyDown}
                  spellCheck={false}
                  placeholder="Type your code or text here..."
                  className="flex-1 bg-slate-900 text-slate-100 font-mono text-xs leading-6 p-4 resize-none outline-none focus:ring-0 w-full overflow-y-auto whitespace-pre tab-2"
                />
              </div>

              {/* Status Bar */}
              <div className="bg-slate-950 border-t border-slate-800 px-4 py-1.5 flex items-center justify-between text-[11px] text-slate-400 select-none flex-shrink-0">
                <div className="flex items-center gap-4">
                  <span>Lines: {lineCount}</span>
                  <span>Size: {Buffer.byteLength(fileContent, 'utf-8')} B</span>
                  <span>UTF-8</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span>Press Ctrl+S to save</span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
              <FileCode className="w-12 h-12 text-slate-600 mb-3" />
              <h3 className="text-base font-bold text-slate-200">No File Open</h3>
              <p className="text-xs text-slate-400 max-w-sm mt-1">
                Select a file from the project tree on the left to view, edit, or recover historical revisions.
              </p>
            </div>
          )}
        </div>

        {/* RIGHT PANEL: REVISION HISTORY DRAWER */}
        {showHistory && (
          <div className="w-full md:w-80 bg-white border-l border-slate-200 flex flex-col flex-shrink-0 shadow-lg z-20">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-purple-600" />
                <h3 className="text-sm font-bold text-slate-900">Revision History</h3>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="p-1 hover:bg-slate-200 rounded text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 bg-slate-50 border-b border-slate-100 text-[11px] text-slate-600">
              Immutable revision log. Restoring a version creates a new snapshot without destructive overwriting.
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {loadingRevisions ? (
                <div className="text-center py-8 text-xs text-slate-400">Loading history...</div>
              ) : revisions.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400">No revisions recorded.</div>
              ) : (
                revisions.map((rev) => (
                  <div
                    key={rev.id}
                    className={`p-3 rounded-xl border transition ${
                      activeFile?.current_revision === rev.revision_number
                        ? 'border-emerald-400 bg-emerald-50/40'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-slate-900">
                        Rev #{rev.revision_number}
                      </span>
                      {activeFile?.current_revision === rev.revision_number && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          Current
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
                      <p className="font-medium text-slate-800">{rev.author_name}</p>
                      <p className="text-[11px] text-slate-400">
                        {new Date(rev.created_at).toLocaleString()}
                      </p>
                    </div>

                    <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setPreviewRevision(rev);
                          setFileContent(rev.content);
                        }}
                        className="px-2 py-1 rounded text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700"
                      >
                        Preview
                      </button>
                      <button
                        onClick={() => handleRestoreRevision(rev.revision_number)}
                        className="px-2 py-1 rounded text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* CONFLICT RESOLUTION MODAL */}
      {conflictData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-2 text-rose-600 mb-2">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <h3 className="text-lg font-bold text-slate-900">Concurrent Edit Conflict Detected</h3>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              While you were editing, teammate <strong>{conflictData.remoteAuthor}</strong> saved an update
              (advancing the file to <strong>Rev #{conflictData.currentRevision}</strong>). To prevent silent
              overwrites, your changes have been held.
            </p>

            <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
              <span className="font-bold text-slate-700 block">Choose how you would like to proceed:</span>
              <ul className="list-disc pl-5 space-y-1 text-slate-600 text-[11px]">
                <li>
                  <strong>Force Overwrite:</strong> Saves your current content as Revision #{conflictData.currentRevision + 1}, preserving both versions in history.
                </li>
                <li>
                  <strong>Discard & Load Remote:</strong> Discards your local unsaved changes and loads the teammate's latest revision.
                </li>
              </ul>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setFileContent(conflictData.remoteContent);
                  setBaseRevision(conflictData.currentRevision);
                  setIsDirty(false);
                  setSaveStatus('saved');
                  setConflictData(null);
                }}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50"
              >
                Discard My Edits & Load Latest
              </button>

              <button
                onClick={() => handleSave(true)}
                className="px-4 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold hover:bg-rose-700 shadow-sm"
              >
                Overwrite with My Changes (Force Save)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE FILE / FOLDER MODAL */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">
              Create New {newType === 'file' ? 'File' : 'Folder'}
            </h3>

            {createError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateNode} className="mt-4 space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1">
                  Type
                </label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 font-medium cursor-pointer">
                    <input
                      type="radio"
                      checked={newType === 'file'}
                      onChange={() => setNewType('file')}
                    />
                    <span>Source File</span>
                  </label>
                  <label className="flex items-center gap-1.5 font-medium cursor-pointer">
                    <input
                      type="radio"
                      checked={newType === 'folder'}
                      onChange={() => setNewType('folder')}
                    />
                    <span>Directory / Folder</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={newType === 'file' ? 'e.g. server.py or utils.ts' : 'e.g. src or models'}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                />
              </div>

              {newType === 'file' && (
                <div>
                  <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1">
                    Initial Content (Optional)
                  </label>
                  <textarea
                    rows={3}
                    value={newInitialContent}
                    onChange={(e) => setNewInitialContent(e.target.value)}
                    placeholder="# Initial code template..."
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono text-xs"
                  />
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createSubmitting}
                  className="px-5 py-2 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-60"
                >
                  {createSubmitting ? 'Creating...' : `Create ${newType === 'file' ? 'File' : 'Folder'}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RENAME MODAL */}
      {renamingNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200">
            <h3 className="text-base font-bold text-slate-900">Rename Item</h3>

            <form onSubmit={handleRenameNode} className="mt-4 space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1">
                  New Name
                </label>
                <input
                  type="text"
                  required
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setRenamingNode(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700"
                >
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
