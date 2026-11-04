import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Project } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { useProjects } from '@/stores/projects'
import { errorMessage } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { t } from '@shared/i18n'

export function ProjectEditor({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved?: (project: Project) => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(project?.workingDirectory ?? null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const pickDirectory = async () => {
    if (busy || picking) return
    setPicking(true)
    try {
      const directory = await call('projects.pickDirectory')
      if (!mounted.current || !directory) return
      setWorkingDirectory(directory)
      setName((current) => (current.trim() ? current : (directory.split(/[\\/]/).filter(Boolean).pop() ?? '')))
    } catch (e) {
      if (mounted.current) toast.error(t('选择文件夹失败'), { description: errorMessage(e) })
    } finally {
      if (mounted.current) setPicking(false)
    }
  }
  const submit = async () => {
    if (busy || picking || !name.trim()) return
    setBusy(true)
    try {
      const saved = await useProjects.getState().save({ id: project?.id, name: name.trim(), description: description.trim(), workingDirectory })
      if (mounted.current) {
        onSaved?.(saved)
        onClose()
      }
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={project ? t('编辑项目') : t('新建项目')}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={busy} disabled={picking || !name.trim()} onClick={() => void submit()}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label={t('名称')}>
            <Input aria-label={t('名称')} autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('工作目录')} hint={t('项目对话会读取和写入此目录。修改目录不会搬移已有文件。')}>
            <div className="flex gap-2">
              <Input
                aria-label={t('工作目录')}
                readOnly
                value={workingDirectory ?? ''}
                placeholder={t('默认 Navo 工作区')}
                title={workingDirectory ?? t('默认 Navo 工作区')}
                className="min-w-0 flex-1"
              />
              <Button variant="secondary" disabled={busy || picking} loading={picking} onClick={() => void pickDirectory()}>
                {t('选择文件夹')}
              </Button>
            </div>
            {workingDirectory ? (
              <Button variant="link" size="sm" disabled={busy || picking} onClick={() => setWorkingDirectory(null)}>
                {t('使用默认工作区')}
              </Button>
            ) : null}
          </Field>
          <Field label={t('描述')}>
            <Textarea aria-label={t('描述')} rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ProjectDeleteDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const remove = async () => {
    setBusy(true)
    try {
      await useProjects.getState().remove(project.id)
      if (mounted.current) onDeleted()
    } catch (e) {
      toast.error(t('删除失败'), { description: errorMessage(e) })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={t('删除项目')}
        description={project.name}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              {t('删除')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t('删除项目后，对话和产物会保留，并移到未归属项目。正在运行的对话不会停止。')}</p>
      </DialogContent>
    </Dialog>
  )
}
