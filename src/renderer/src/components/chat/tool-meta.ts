import {
  Bot,
  Clapperboard,
  Send,
  Settings2,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  MousePointerClick,
  Puzzle,
  Server,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { ToolCall } from '@shared/types'

const LABELS: Record<string, string> = {
  browser_navigate: t('打开网页'),
  browser_snapshot: t('读取页面'),
  browser_click: t('点击'),
  browser_type: t('输入'),
  browser_select: t('选择'),
  browser_hover: t('悬停'),
  browser_press_key: t('按键'),
  browser_scroll: t('滚动'),
  browser_wait_for: t('等待'),
  browser_screenshot: t('截图'),
  browser_extract: t('提取内容'),
  browser_eval: t('执行脚本'),
  browser_tabs: t('标签页'),
  browser_history: t('前进/后退'),
  browser_upload_file: t('上传文件'),
  write_todos: t('更新计划'),
  task: t('委派子代理'),
  read_file: t('读取文件'),
  write_file: t('写入文件'),
  edit_file: t('编辑文件'),
  ls: t('列出目录'),
  glob: t('查找文件'),
  grep: t('搜索内容'),
  codex_run_command: t('执行命令'),
  codex_file_change: t('修改文件'),
  codex_mcp_tool: t('调用 MCP 工具'),
  codex_dynamic_tool: t('执行动态工具'),
  codex_web_search: t('搜索网页'),
  navo_list_conversations: t('查看对话列表'),
  navo_get_conversation: t('查看对话'),
  navo_send_message: t('派发任务给新对话'),
  navo_stop: t('停止对话'),
  navo_rename_conversation: t('重命名对话'),
  navo_delete_conversation: t('删除对话'),
  navo_list_models: t('查看模型'),
  navo_test_model: t('测试模型'),
  navo_set_default_model: t('设置默认模型'),
  navo_list_skills: t('查看 Skill'),
  navo_read_skill: t('读取 Skill'),
  navo_save_skill: t('保存 Skill'),
  navo_set_skill_enabled: t('启用/禁用 Skill'),
  navo_delete_skill: t('删除 Skill'),
  navo_list_mcp_servers: t('查看 MCP 服务器'),
  navo_add_mcp_server: t('添加 MCP 服务器'),
  navo_set_mcp_server_enabled: t('启用/禁用 MCP 服务器'),
  navo_remove_mcp_server: t('移除 MCP 服务器'),
  navo_list_connectors: t('查看连接器'),
  navo_connect_connector: t('连接连接器'),
  navo_set_connector_enabled: t('启用/暂停连接器'),
  navo_disconnect_connector: t('断开连接器'),
}

const LEGACY_NAMES: Record<string, string> = {
  'codex.commandExecution': 'codex_run_command',
  'codex.fileChange': 'codex_file_change',
  'codex.mcpToolCall': 'codex_mcp_tool',
  'codex.dynamicToolCall': 'codex_dynamic_tool',
  'codex.webSearch': 'codex_web_search',
}

export function toolMeta(rawName: string): { label: string; icon: LucideIcon } {
  const name = LEGACY_NAMES[rawName] ?? rawName
  if (name.startsWith('plugin_')) return { label: t('插件 · {{v0}}', { v0: name.replace(/^plugin_/, '') }), icon: Puzzle }
  if (name.startsWith('macro_')) return { label: t('宏 · {{v0}}', { v0: name.replace(/^macro_/, '') }), icon: Clapperboard }
  if (name.startsWith('mcp__')) return { label: name.split('__').slice(1).join(' · '), icon: Server }
  if (name.startsWith('navo_')) return { label: `Navo · ${LABELS[name] ?? name.replace(/^navo_/, '')}`, icon: name === 'navo_send_message' ? Send : Settings2 }
  const label = LABELS[name] ?? name
  if (name === 'codex_run_command') return { label, icon: Terminal }
  if (name === 'codex_file_change') return { label, icon: FilePen }
  if (name === 'codex_web_search') return { label, icon: Globe }
  if (name === 'codex_mcp_tool') return { label, icon: Server }
  if (name === 'browser_click') return { label, icon: MousePointerClick }
  if (name.startsWith('browser_')) return { label, icon: Globe }
  if (name === 'write_todos') return { label, icon: ListChecks }
  if (name === 'task') return { label, icon: Bot }
  if (name === 'write_file' || name === 'edit_file') return { label, icon: FilePen }
  if (name === 'read_file') return { label, icon: FileText }
  if (name === 'ls' || name === 'glob' || name === 'grep') return { label, icon: FolderSearch }
  if (name.includes('skill')) return { label, icon: Sparkles }
  return { label, icon: Wrench }
}

/** Normalized activity drives presentation; name aliases only keep existing history readable. */
export function toolPresentation(call: ToolCall): { label: string; icon: LucideIcon; summary: string; command?: string; cwd?: string; paths?: string[] } {
  const activity = call.activity
  const metadata = toolMeta(call.name)
  const kind = activity?.kind ?? ((LEGACY_NAMES[call.name] ?? call.name) === 'codex_run_command' ? 'command' : undefined)
  const command = activity?.command ?? (kind === 'command' && typeof call.args.command === 'string' ? call.args.command : undefined)
  const cwd = activity?.cwd ?? (kind === 'command' && typeof call.args.cwd === 'string' ? call.args.cwd : undefined)
  const label =
    activity?.label || (kind === 'command' ? t('执行命令') : kind === 'file_change' ? t('修改文件') : kind === 'search' ? t('搜索内容') : metadata.label)
  const icon = kind === 'command' ? Terminal : kind === 'file_change' ? FilePen : kind === 'search' ? FolderSearch : metadata.icon
  const summary = command || activity?.paths?.join(', ') || argSummary(call.name, call.args)
  return { label, icon, summary: summary.replace(/\s+/g, ' '), command, cwd, paths: activity?.paths }
}

/** Stable safety hint for users: identifies the execution boundary without exposing raw vendor protocol. */
export function toolScopeLabel(name: string): string {
  if (name.startsWith('browser_')) return t('Navo 浏览器')
  if (name.startsWith('desktop_')) return t('Navo 桌面')
  if (name.startsWith('mcp_') || name.includes('.mcp')) return t('MCP 服务')
  if (name.startsWith('plugin_')) return t('插件')
  if (name.startsWith('memory_')) return t('记忆')
  if (name.includes('codex_') || name.includes('claude_')) return t('外部运行时')
  if (['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep'].includes(name)) return t('项目工作区')
  return t('Navo 工具')
}

/** One-line summary of the most meaningful argument. */
export function argSummary(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === 'string' || typeof args[k] === 'number' ? String(args[k]) : '')
  const v =
    pick('command') ||
    pick('query') ||
    pick('url') ||
    pick('text') ||
    pick('ref') ||
    pick('key') ||
    pick('file_path') ||
    pick('path') ||
    pick('pattern') ||
    pick('description') ||
    pick('subagent_type') ||
    pick('action') ||
    pick('selector')
  if (name === 'browser_type' && args.ref) return `${args.ref} ← ${String(args.text ?? '')}`
  return v.replace(/\s+/g, ' ').slice(0, 80)
}
