import { useState } from 'react'
import { toast } from 'sonner'
import { presetPricing } from '@shared/pricing'
import type { ModelConfig, ModelPricing } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

const num = (v: string) => (v.trim() === '' ? null : Number(v))

/** Price per million tokens of one model, for the usage page's cost estimates. */
export function PricingDialog({ model, onClose, onSaved }: { model: ModelConfig; onClose: () => void; onSaved: () => void }) {
  const preset = presetPricing(model.model)
  const start = model.pricing ?? preset
  const [currency, setCurrency] = useState<ModelPricing['currency']>(start?.currency ?? 'CNY')
  const [input, setInput] = useState(start?.input?.toString() ?? '')
  const [cached, setCached] = useState(start?.cachedInput?.toString() ?? '')
  const [output, setOutput] = useState(start?.output?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const valid = [input, output].every((v) => v.trim() !== '' && Number(v) >= 0) && (cached.trim() === '' || Number(cached) >= 0)

  const save = async (pricing: ModelPricing | null) => {
    setSaving(true)
    try {
      await call('models.setPricing', model.id, pricing)
      toast.success(pricing ? t('价格已保存') : t('已清除价格'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('价格 · {{v0}}', { v0: model.displayName })}
        description={t('每百万 token 的单价，用来估算「用量」页面里的费用。以服务商的实际账单为准。')}
        footer={
          <>
            {model.pricing ? (
              <Button variant="ghost" className="mr-auto" disabled={saving} onClick={() => void save(null)}>
                {t('清除价格')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!valid}
              onClick={() => void save({ input: Number(input), output: Number(output), cachedInput: num(cached), currency })}
            >
              {t('保存')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!model.pricing && preset ? (
            <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-muted-foreground">
              {t('已按 {{v0}} 的参考价填好，服务商调价时请以实际价格为准。', { v0: model.model })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('输入（每百万 token）')}>
              <Input type="number" min={0} step="0.01" value={input} onChange={(e) => setInput(e.target.value)} aria-label={t('输入单价')} />
            </Field>
            <Field label={t('输出（每百万 token）')}>
              <Input type="number" min={0} step="0.01" value={output} onChange={(e) => setOutput(e.target.value)} aria-label={t('输出单价')} />
            </Field>
            <Field label={t('缓存命中的输入（可选）')} hint={t('留空则按输入单价计')}>
              <Input type="number" min={0} step="0.01" value={cached} onChange={(e) => setCached(e.target.value)} aria-label={t('缓存单价')} />
            </Field>
            <Field label={t('币种')}>
              <Select
                value={currency}
                onChange={(v) => setCurrency(v as ModelPricing['currency'])}
                options={[
                  { value: 'CNY', label: t('人民币 ¥') },
                  { value: 'USD', label: t('美元 $') },
                ]}
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
