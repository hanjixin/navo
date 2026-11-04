import { currentSearchParams } from '@/lib/routes'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { PageHeader } from '@/components/layout/page'
import { ArtifactBrowser } from '@/components/artifacts/artifact-browser'
import { Select } from '@/components/ui/select'
import { ErrorState } from '@/components/ui/states'
import { useProjects } from '@/stores/projects'
import { t } from '@shared/i18n'

export function ArtifactsPage() {
  const { projects, error, load } = useProjects()
  const [params, setParams] = useSearchParams()
  const selected = params.get('project') ?? 'all'
  const projectId = selected === 'all' ? undefined : selected === 'none' ? null : selected
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (projects && projectId && !projects.some((p) => p.id === projectId)) {
      setParams(
        () => {
          const next = currentSearchParams()
          next.delete('project')
          return next
        },
        { replace: true },
      )
    }
  }, [projects, projectId, setParams])
  return (
    <div className="@container flex h-full min-w-0 flex-col px-6 py-6 @4xl:px-8">
      <PageHeader
        title={t('Artifacts')}
        description={t('按项目查看 Agent 写下或下载的文件。')}
        actions={
          <Select
            value={selected}
            className="w-52"
            onChange={(v) =>
              setParams(() => {
                const next = currentSearchParams()
                if (v === 'all') next.delete('project')
                else next.set('project', v)
                next.delete('artifact')
                next.delete('panel')
                return next
              })
            }
            options={[
              { value: 'all', label: t('全部项目') },
              { value: 'none', label: t('未归属项目') },
              ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        }
      />
      {error ? <ErrorState error={error} onRetry={() => void load()} compact className="mb-4" /> : null}
      <ArtifactBrowser projectId={projectId} />
    </div>
  )
}
