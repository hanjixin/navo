import { useState } from 'react'
import { Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentTemplates, agentTemplateTeams, type AgentTemplateId, type AgentTemplateTeamId } from '@shared/agent-templates'
import type { AgentProfile } from '@shared/types'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface Props {
  agents?: AgentProfile[]
  resourceName: (kind: 'connector' | 'plugin', id: string) => string
  onAdded: () => Promise<void>
}

export function TeamTemplatePicker({ agents, resourceName, onAdded }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const teams = agentTemplateTeams()
  const templates = agentTemplates()
  const installed = new Set(agents?.map((agent) => agent.templateId))

  const install = async (choice: { team: AgentTemplateTeamId } | { template: AgentTemplateId }) => {
    setBusy(true)
    try {
      if ('team' in choice) await call('agents.addTemplateTeam', choice.team)
      else await call('agents.addTemplate', choice.template)
      await onAdded()
      setOpen(false)
      toast.success(t('已添加到我的智能体'))
    } catch (error) {
      toast.error(t('添加失败'), { description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Users />
          {t('从团队模板添加')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('从团队模板添加')} description={t('选择团队，一次添加整组助手，也可以单独添加。')}>
        <Tabs defaultValue={teams[0].id}>
          <TabsList aria-label={t('选择团队')}>
            {teams.map((team) => (
              <TabsTrigger key={team.id} value={team.id}>
                {team.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {teams.map((team) => {
            const members = templates.filter((template) => template.team === team.id)
            const remaining = members.filter((template) => !installed.has(template.id)).length
            return (
              <TabsContent key={team.id} value={team.id}>
                <div className="divide-y divide-border">
                  {members.map((template) => {
                    const names = [
                      ...template.connectors.map((id) => resourceName('connector', id)),
                      ...template.plugins.map((id) => resourceName('plugin', id)),
                    ]
                    const added = installed.has(template.id)
                    return (
                      <article key={template.id} className="flex items-start gap-3 py-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-semibold">{template.name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
                          <p className="mt-1.5 text-xs text-subtle-foreground">{t('推荐资源：{{names}}', { names: names.join(' · ') })}</p>
                        </div>
                        <Button size="sm" disabled={!agents || added || busy} onClick={() => void install({ template: template.id })}>
                          {added ? t('已添加') : t('一键添加')}
                        </Button>
                      </article>
                    )
                  })}
                </div>
                <div className="flex justify-end border-t border-border pt-3">
                  <Button variant="primary" disabled={!agents || busy || !remaining} onClick={() => void install({ team: team.id })}>
                    {remaining ? (
                      <>
                        <Plus />
                        {t('添加团队助手（{{count}}）', { count: remaining })}
                      </>
                    ) : (
                      t('已全部添加')
                    )}
                  </Button>
                </div>
              </TabsContent>
            )
          })}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
