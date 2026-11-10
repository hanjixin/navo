import { CompositeBackend, StateBackend } from 'deepagents'
import { WorkspaceBackend } from '../agent-host/workspace-backend'
import { ScopedSkillBackend } from '../skills/scoped-backend'
import type { RunRequest } from './contracts'

export type RuntimeFilesystemConfig = Pick<RunRequest, 'paths' | 'mounts'>

/** Identical virtual mounts and write boundaries for every Navo tool runtime. */
export function createRuntimeFilesystem(config: RuntimeFilesystemConfig, changed: (path: string) => Promise<void>) {
  return new CompositeBackend(new StateBackend(), {
    '/workspace/': new WorkspaceBackend(config.paths.workspace, changed),
    '/skills/': new ScopedSkillBackend(config.paths.skills, null, 'Skill 文件不能直接改写。改进已有 Skill 用 skill_note，新建或重写用 navo_save_skill。'),
    '/uploads/': new ScopedSkillBackend(config.paths.uploads, null, '上传的文件是只读的。'),
    ...Object.fromEntries(config.mounts.map((mount) => [`/ext/${mount.id}/`, new ScopedSkillBackend(mount.root, new Set(mount.allowed))])),
  })
}
