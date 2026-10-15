import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ConnectorDef, ConnectorState } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * Connects a connector that takes a form (app credentials, a webhook, a mailbox). On a reconnect the
 * stored values are shown, except secrets: left blank, they stay as they are.
 */
export function FieldsDialog({ def, state, onClose, onDone }: { def: ConnectorDef; state?: ConnectorState; onClose: () => void; onDone: () => void }) {
  const fields = def.fields ?? []
  const editing = !!state?.connected || !!state?.config
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, state?.config?.[f.key] ?? f.default ?? ''])),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const visible = fields.filter((f) => !f.showIf || f.showIf.values.includes(values[f.showIf.key] ?? ''))
  const ready = visible.every((f) => f.optional || (f.secret ? editing || values[f.key]?.trim() : values[f.key]?.trim()))

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      await call('connectors.connect', def.id, values)
      toast.success(t('已连接 {{v0}}', { v0: def.name }))
      onDone()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${editing ? t('修改') : t('连接')} ${def.name}`}
        description={
          def.kind === 'stdio' ? t('官方 MCP 服务会在本机启动（需要 Node.js），凭证加密保存在钥匙串。') : t('凭证加密保存在本机钥匙串，只用于这个连接器。')
        }
        className="w-[520px]"
        footer={
          <>
            {def.setupHelp ? (
              <Button variant="link" size="sm" className="mr-auto text-xs" onClick={() => void call('app.openExternal', def.setupHelp!)}>
                {t('怎么获取')}
                <ExternalLink className="size-3" />
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={pending} disabled={!ready} onClick={() => void submit()}>
              {editing ? t('保存并重新连接') : t('连接')}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) void submit()
          }}
        >
          {visible.map((f, i) =>
            f.options ? (
              <Field key={f.key} label={f.label} hint={f.help}>
                <Select value={values[f.key] || f.options[0].value} onChange={(v) => setValues({ ...values, [f.key]: v })} options={f.options} />
              </Field>
            ) : (
              <Field key={f.key} label={f.label} hint={f.help}>
                <Input
                  type={f.secret ? 'password' : 'text'}
                  aria-label={f.label}
                  autoFocus={i === 0}
                  value={values[f.key] ?? ''}
                  placeholder={f.secret && editing ? t('已保存，留空则不变') : f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className={f.secret || f.key.includes('host') || f.key === 'webhook' ? 'font-mono text-xs' : undefined}
                />
              </Field>
            ),
          )}
          {error ? <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : null}
          <button type="submit" hidden />
        </form>
      </DialogContent>
    </Dialog>
  )
}
