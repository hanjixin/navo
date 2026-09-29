import type { PluginManifest } from '@shared/types'

export const EXAMPLE_PLUGINS: { manifest: PluginManifest; content: string }[] = [
  {
    manifest: {
      id: 'hacker-news',
      name: 'Hacker News',
      version: '1.0.0',
      description: '示例插件：读取与打开 Hacker News 首页文章',
      matches: ['https://news.ycombinator.com/*'],
      contentScript: 'content.js',
      actions: [
        {
          name: 'list_stories',
          description: '列出当前页面上的文章（标题、链接、分数、评论数）',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: '最多返回条数，默认 30' } },
          },
        },
        {
          name: 'open_story',
          description: '打开第 N 篇文章（从 1 开始）',
          parameters: {
            type: 'object',
            properties: { index: { type: 'number' }, comments: { type: 'boolean', description: '是否打开评论页' } },
            required: ['index'],
          },
        },
      ],
    },
    content: `// Hacker News 示例插件。运行在隔离环境中，可直接读写 DOM。
function rows() {
  return Array.from(document.querySelectorAll('tr.athing')).map((row, i) => {
    const link = row.querySelector('.titleline > a')
    const sub = row.nextElementSibling
    const score = sub?.querySelector('.score')?.textContent ?? ''
    const commentsLink = Array.from(sub?.querySelectorAll('a') ?? []).find((a) => /comment|discuss/.test(a.textContent))
    return {
      index: i + 1,
      title: link?.textContent?.trim(),
      url: link?.href,
      score: parseInt(score) || 0,
      comments: parseInt(commentsLink?.textContent ?? '') || 0,
      commentsUrl: commentsLink?.href,
    }
  })
}

agentPlugin.register('list_stories', async ({ limit = 30 } = {}) => rows().slice(0, limit))

agentPlugin.register('open_story', async ({ index, comments = false }) => {
  const story = rows()[index - 1]
  if (!story) throw new Error('没有第 ' + index + ' 篇文章')
  location.href = comments ? story.commentsUrl : story.url
  return '正在打开: ' + story.title
})
`,
  },
]
