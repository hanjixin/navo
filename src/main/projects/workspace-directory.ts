import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { t } from '@shared/i18n'

export function validateWorkingDirectory(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(t('工作目录必须是绝对路径'))
  try {
    const root = realpathSync(value)
    if (!statSync(root).isDirectory()) throw new Error('not a directory')
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
    return root
  } catch {
    throw new Error(t('工作目录不存在或无法读写'))
  }
}

/** Approval resumes must use the persisted root of the interrupted turn. */
export function resolveRunWorkspaceRoot(
  kind: 'message' | 'resume',
  configuredRoot: string | null,
  defaultRoot: string,
  interruptedRoot: string | null,
): string {
  if (kind === 'resume') {
    if (!interruptedRoot) throw new Error(t('无法恢复工作目录，请重新发送任务'))
    return validateWorkingDirectory(interruptedRoot)
  }
  return configuredRoot ? validateWorkingDirectory(configuredRoot) : defaultRoot
}
