import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import { cn } from '@/lib/utils'
import { fileReferenceFromHref, rehypeFileLinks } from '@shared/file-link'
import { t } from '@shared/i18n'

const plugins = { code, cjk }

const translations = {
  close: t('关闭'),
  copied: t('已复制'),
  copyCode: t('复制代码'),
  copyLink: t('复制链接'),
  copyTable: t('复制表格'),
  copyTableAsCsv: t('复制为 CSV'),
  copyTableAsMarkdown: t('复制为 Markdown'),
  copyTableAsTsv: t('复制为 TSV'),
  downloadFile: t('下载'),
  downloadImage: t('下载图片'),
  downloadTable: t('下载表格'),
  downloadTableAsCsv: t('下载为 CSV'),
  downloadTableAsMarkdown: t('下载为 Markdown'),
  exitFullscreen: t('退出全屏'),
  openExternalLink: t('打开外部链接'),
  openLink: t('打开链接'),
  resetView: t('重置视图'),
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: t('全屏查看'),
  zoomIn: t('放大'),
  zoomOut: t('缩小'),
}

export const Markdown = memo(function Markdown({
  text,
  className,
  onFileOpen,
}: {
  text: string
  className?: string
  onFileOpen?: (path: string) => void | Promise<void>
}) {
  return (
    <Streamdown
      className={cn('prose-chat', className)}
      plugins={plugins}
      controls={{ code: true, table: true, image: true }}
      linkSafety={{ enabled: false }}
      rehypePlugins={onFileOpen ? [rehypeFileLinks] : undefined}
      translations={translations}
      data-testid="markdown"
      components={{
        a: ({ href, children }) => {
          const path = fileReferenceFromHref(href)
          return path ? (
            <a
              href={href}
              title={t('打开文件：{{v0}}', { v0: path })}
              className="navo-file-link"
              onClick={(event) => {
                event.preventDefault()
                void onFileOpen?.(path)
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        },
      }}
    >
      {text}
    </Streamdown>
  )
})
