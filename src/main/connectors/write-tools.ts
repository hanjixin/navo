/** Tool names that change something (Feishu: im_v1_message_create; DingTalk: sendMessageToGroupByRobot…). */
const WRITE = /create|send|update|delete|recall|remove|add|import|batch|patch|permission/i

/** Whether an office connector's tool writes (it then pauses for approval); MCP's mcp__<server>__ prefix is ignored. */
export const isWriteTool = (name: string) => WRITE.test(name.replace(/^mcp__[^_]+__/, ''))
