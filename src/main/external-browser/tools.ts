import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { emit } from '../core/ipc'
import { fullSnapshot, type ToolCtx } from '../browser/tools'
import { bridge, liveView, targets } from './instance'
import { ExternalPageDriver } from './ext-tabs'
import { NeedExtension, SANDBOX } from './targets'

/** browser_switch: which browser the conversation's browser_* tools drive. */
export function createSwitchTool(ctx: ToolCtx) {
  return tool(
    async ({ target }) => {
      const threadId = ctx.threadId ?? SANDBOX
      if (target === 'builtin') {
        const was = targets.page(threadId)
        if (was instanceof ExternalPageDriver) await liveView.release(was)
        await targets.useBuiltin(threadId)
        return '已切换回内置浏览器。'
      }
      try {
        const d = await targets.useMine(threadId)
        await d.prepare()
        return `已切换到你的浏览器（${bridge.link()?.browser ?? '浏览器'}）：\n${await fullSnapshot(d)}`
      } catch (err) {
        if (!(err instanceof NeedExtension)) throw err
        emit('computerUse.guide', undefined)
        return "用户还没有连接 Navo 浏览器扩展。界面上已弹出安装引导，请让用户按引导完成后告诉你，再调用 browser_switch('mine')。"
      }
    },
    {
      name: 'browser_switch',
      description:
        '切换本对话使用的浏览器：builtin 为 Navo 内置浏览器（默认）；mine 为用户自己的浏览器（Chrome / Edge 等，已登录的账号和插件都在）。切换后 browser_* 工具都作用在该浏览器上。',
      schema: z.object({ target: z.enum(['builtin', 'mine']) }),
    },
  )
}
