import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { emit } from '../core/ipc'
import { fullSnapshot, type ToolCtx } from '../browser/tools'
import { bridge, targets } from './instance'
import { NeedExtension, SANDBOX } from './targets'

/** browser_switch: which browser the conversation's browser_* tools drive. */
export function createSwitchTool(ctx: ToolCtx) {
  return tool(
    async ({ target }) => {
      const threadId = ctx.threadId ?? SANDBOX
      if (target === 'builtin') {
        await targets.useBuiltin(threadId)
        return '已切换回内置浏览器。'
      }
      try {
        const d = await targets.useMine(threadId)
        await d.prepare()
        return `已切换到你的浏览器（${bridge.link()?.browser ?? '浏览器'}）。后续请使用 browser_*。只可操作 Navo 打开或你通过扩展交给 Navo 的标签页。\n\n${await fullSnapshot(d)}`
      } catch (err) {
        if (!(err instanceof NeedExtension)) throw err
        emit('computerUse.guide', undefined)
        return "用户还没有连接 Navo 浏览器扩展。界面上已弹出安装引导，请让用户按引导完成后告诉你，再调用 browser_switch('mine')。"
      }
    },
    {
      name: 'browser_switch',
      description:
        '切换本对话使用的浏览器。用户要求操作自己的 Chrome / Edge 时，传 target: "mine"，通过已连接的 Navo 扩展切换；target: "builtin" 切回内置浏览器。切换后继续使用 browser_*，只可操作 Navo 打开或用户通过扩展交给 Navo 的标签页。',
      schema: z.object({ target: z.enum(['builtin', 'mine']) }),
    },
  )
}
