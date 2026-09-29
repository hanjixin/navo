/** Output of every parser: Markdown that keeps structure (headings, lists, tables, page/slide/sheet boundaries). */
export interface ParseResult {
  markdown: string
  kind: FileKind
  title?: string
  /** pages (pdf), slides (pptx/odp) or sheets (xlsx/ods/csv) */
  units?: number
  unitLabel?: '页' | '张幻灯片' | '个工作表' | '个文件' | '章'
  /** pages that were OCR'd because they had no text layer */
  ocrPages?: number[]
  warnings: string[]
  engine: string
}

export type FileKind = 'pdf' | 'word' | 'sheet' | 'slides' | 'ebook' | 'html' | 'text' | 'code' | 'data' | 'image' | 'archive' | 'unknown'

export interface ParseOptions {
  /** directory with pdf.js cmaps/ and standard_fonts/ */
  pdfAssetsDir: string
  /** where OCR language data is cached */
  ocrCacheDir: string
  /** bundled language data (<lang>.traineddata.gz); downloaded from jsDelivr when missing */
  ocrLangDir?: string
  /** OCR scanned PDF pages and images (default true) */
  ocr?: boolean
  onProgress?: (message: string) => void
  /** where model-ready images (image.jpg, page-N.jpg, thumb.jpg) are written; omitted in nested archives */
  visualsDir?: string
  /** nesting depth for archives */
  depth?: number
}

export class UnsupportedFileError extends Error {}
