const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff'
const FULL: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' }

/** Speech engines often put ASCII punctuation in Chinese text; next to Chinese characters it becomes full-width. */
export function fullWidthPunctuation(text: string): string {
  return text.replace(new RegExp(`(?<=[${CJK}])\\s*([,?!:;])\\s*(?=[${CJK}]|$)`, 'g'), (_, p: string) => FULL[p]).replace(new RegExp(`(?<=[${CJK}])\\.$`), '。')
}
