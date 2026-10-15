// Keeps the English interface complete: every t('…') / tk('…') key has a translation in
// src/shared/locales/en.json, en.json has no leftovers, and the renderer shows no Chinese outside t().
//   node scripts/i18n-check.mjs            check (exit 1 on problems)
//   node scripts/i18n-check.mjs --missing  print the missing keys as JSON (to translate)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const HAN = /[㐀-鿿]/
/** shown as is in every language (a language's own name in the language picker) */
const NATIVE = new Set(['中文'])
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : [],
  )

const keys = new Map() // key → first place it is used
const unwrapped = []
for (const file of files('src')) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const renderer = file.startsWith(join('src', 'renderer'))
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['t', 'tk'].includes(n.expression.text)) {
      const a = n.arguments[0]
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
        if (!keys.has(a.text)) keys.set(a.text, at(a))
        // the values filled in may hold text of their own
        n.arguments.slice(1).forEach(visit)
        return
      }
    }
    if (
      renderer &&
      (ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isJsxText(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)) &&
      HAN.test(n.text)
    ) {
      // comparing with a value that comes from the main process is fine (the shown text goes through t())
      const p = n.parent
      if (!(ts.isBinaryExpression(p) && /^[!=]==?$/.test(p.operatorToken.getText(sf))) && !NATIVE.has(n.text))
        unwrapped.push(`${at(n)}  ${n.getText(sf).slice(0, 60).replace(/\n/g, ' ')}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const en = JSON.parse(readFileSync('src/shared/locales/en.json', 'utf8'))
const missing = [...keys.keys()].filter((k) => !(k in en))
const unused = Object.keys(en).filter((k) => !keys.has(k))
// interpolations are {{v0}}, {{v1}}…; other braces are text to show (e.g. how to write a macro parameter)
const placeholders = (s) =>
  [...s.matchAll(/\{\{(v\d+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join()
const broken = Object.entries(en).filter(([k, v]) => keys.has(k) && placeholders(k) !== placeholders(v))

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(Object.fromEntries(missing.map((k) => [k, ''])), null, 2))
  process.exit(0)
}
const report = (title, list) => list.length && console.log(`${title} (${list.length}):\n  ${list.slice(0, 30).join('\n  ')}${list.length > 30 ? '\n  …' : ''}`)
report(
  'Missing English translations',
  missing.map((k) => `${k}  — ${keys.get(k)}`),
)
report('Translations no longer used', unused)
report(
  'Placeholders differ from the Chinese',
  broken.map(([k, v]) => `${k} → ${v}`),
)
report('Chinese shown without t()', unwrapped)
if (missing.length || unused.length || broken.length || unwrapped.length) process.exit(1)
console.log(`i18n: ${keys.size} strings, all translated`)
