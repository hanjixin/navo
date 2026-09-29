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
  Wrench,
  type LucideIcon,
} from 'lucide-react'

const LABELS: Record<string, string> = {
  browser_navigate: '打开网页',
  browser_snapshot: '读取页面',
  browser_click: '点击',
  browser_type: '输入',
  browser_select: '选择',
  browser_hover: '悬停',
  browser_press_key: '按键',
  browser_scroll: '滚动',
  browser_wait_for: '等待',
  browser_screenshot: '截图',
  browser_extract: '提取内容',
  browser_eval: '执行脚本',
  browser_tabs: '标签页',
  browser_history: '前进/后退',
  browser_upload_file: '上传文件',
  write_todos: '更新计划',
  task: '委派子代理',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  ls: '列出目录',
  glob: '查找文件',
  grep: '搜索内容',
  navo_list_conversations: '查看对话列表',
  navo_get_conversation: '查看对话',
  navo_send_message: '派发任务给新对话',
  navo_stop: '停止对话',
  navo_rename_conversation: '重命名对话',
  navo_delete_conversation: '删除对话',
  navo_list_models: '查看模型',
  navo_test_model: '测试模型',
  navo_set_default_model: '设置默认模型',
  navo_list_skills: '查看 Skill',
  navo_read_skill: '读取 Skill',
  navo_save_skill: '保存 Skill',
  navo_set_skill_enabled: '启用/禁用 Skill',
  navo_delete_skill: '删除 Skill',
  navo_list_mcp_servers: '查看 MCP 服务器',
  navo_add_mcp_server: '添加 MCP 服务器',
  navo_set_mcp_server_enabled: '启用/禁用 MCP 服务器',
  navo_remove_mcp_server: '移除 MCP 服务器',
  navo_list_connectors: '查看连接器',
  navo_connect_connector: '连接连接器',
  navo_set_connector_enabled: '启用/暂停连接器',
  navo_disconnect_connector: '断开连接器',
}

export function toolMeta(name: string): { label: string; icon: LucideIcon } {
  if (name.startsWith('plugin_')) return { label: `插件 · ${name.replace(/^plugin_/, '')}`, icon: Puzzle }
  if (name.startsWith('macro_')) return { label: `宏 · ${name.replace(/^macro_/, '')}`, icon: Clapperboard }
  if (name.startsWith('mcp__')) return { label: name.split('__').slice(1).join(' · '), icon: Server }
  if (name.startsWith('navo_')) return { label: `Navo · ${LABELS[name] ?? name.replace(/^navo_/, '')}`, icon: name === 'navo_send_message' ? Send : Settings2 }
  const label = LABELS[name] ?? name
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

/** One-line summary of the most meaningful argument. */
export function argSummary(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === 'string' || typeof args[k] === 'number' ? String(args[k]) : '')
  const v =
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
    pick('query') ||
    pick('selector')
  if (name === 'browser_type' && args.ref) return `${args.ref} ← ${String(args.text ?? '')}`
  return v.replace(/\s+/g, ' ').slice(0, 80)
}
