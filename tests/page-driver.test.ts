import { describe, expect, it } from 'vitest'
import { dialogNotice, chooserNotice } from '../src/main/browser/dialogs'

describe('dialogNotice', () => {
  const m = (o: object) => '__navo_dialog__' + JSON.stringify(o)
  it('describes each dialog kind and its outcome', () => {
    expect(dialogNotice(m({ type: 'alert', message: '已保存', answer: null }))).toBe('页面弹出提示框：「已保存」，已关闭')
    expect(dialogNotice(m({ type: 'confirm', message: '删除？', answer: false }))).toContain('已自动选择「取消」')
    expect(dialogNotice(m({ type: 'confirm', message: '删除？', answer: false }))).toContain('browser_set_dialog_policy')
    expect(dialogNotice(m({ type: 'prompt', message: '名字', answer: 'Ada' }))).toContain('已填写「Ada」')
  })
  it('ignores other console output', () => {
    expect(dialogNotice('hello')).toBeNull()
    expect(dialogNotice('__navo_dialog__{bad')).toBeNull()
  })
  it('chooserNotice mentions multi-select', () => {
    expect(chooserNotice('selectMultiple')).toContain('可多选')
    expect(chooserNotice('selectSingle')).toContain('单选')
  })
})
