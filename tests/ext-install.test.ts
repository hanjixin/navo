import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { installExtension } from '../src/main/external-browser/install'

describe('installExtension', () => {
  let root: string
  let src: string
  let dest: string
  const writeSrc = (version: string, files: Record<string, string> = {}) => {
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'Navo', version }))
    for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ext-install-'))
    src = join(root, 'src')
    dest = join(root, 'dest')
  })

  it('copies the extension the first time', () => {
    writeSrc('0.1.0', { 'background.js': 'a' })
    expect(installExtension(src, dest)).toEqual({ dir: dest, updated: true })
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).version).toBe('0.1.0')
    expect(readFileSync(join(dest, 'background.js'), 'utf8')).toBe('a')
  })

  it('leaves identical bundled contents alone', () => {
    writeSrc('0.1.0', { 'background.js': 'a' })
    installExtension(src, dest)
    const before = statSync(join(dest, 'background.js')).mtimeMs
    expect(installExtension(src, dest)).toEqual({ dir: dest, updated: false })
    expect(statSync(join(dest, 'background.js')).mtimeMs).toBe(before)
    expect(readFileSync(join(dest, 'background.js'), 'utf8')).toBe('a')
  })

  it('updates changed scripts without a version bump', () => {
    writeSrc('0.1.0', { 'background.js': 'a' })
    installExtension(src, dest)
    const inode = statSync(dest).ino
    writeFileSync(join(src, 'background.js'), 'changed but same version')
    expect(installExtension(src, dest)).toEqual({ dir: dest, updated: true })
    expect(readFileSync(join(dest, 'background.js'), 'utf8')).toBe('changed but same version')
    expect(statSync(dest).ino).toBe(inode)
    expect(installExtension(src, dest).updated).toBe(false)
  })

  it('detects changed icons and added or removed bundle files', () => {
    writeSrc('0.1.0', { 'old.js': 'old' })
    mkdirSync(join(src, 'icons'))
    writeFileSync(join(src, 'icons', '16.png'), Buffer.from([0, 1, 2]))
    installExtension(src, dest)
    writeFileSync(join(src, 'icons', '16.png'), Buffer.from([0, 2, 2]))
    expect(installExtension(src, dest).updated).toBe(true)
    expect(readFileSync(join(dest, 'icons', '16.png'))).toEqual(Buffer.from([0, 2, 2]))
    rmSync(join(src, 'old.js'))
    expect(installExtension(src, dest).updated).toBe(true)
    expect(existsSync(join(dest, 'old.js'))).toBe(false)
    writeFileSync(join(src, 'new.js'), 'new')
    expect(installExtension(src, dest).updated).toBe(true)
    expect(readFileSync(join(dest, 'new.js'), 'utf8')).toBe('new')
    expect(installExtension(src, dest).updated).toBe(false)
  })

  it('replaces files when the version changes, keeping the folder', () => {
    writeSrc('0.1.0', { 'old.js': 'x' })
    installExtension(src, dest)
    const inode = statSync(dest).ino
    rmSync(src, { recursive: true })
    writeSrc('0.2.0', { 'background.js': 'b' })
    expect(installExtension(src, dest).updated).toBe(true)
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).version).toBe('0.2.0')
    expect(existsSync(join(dest, 'old.js'))).toBe(false)
    expect(statSync(dest).ino).toBe(inode)
  })

  it('repairs a folder whose manifest went missing', () => {
    writeSrc('0.1.0')
    installExtension(src, dest)
    rmSync(join(dest, 'manifest.json'))
    expect(installExtension(src, dest).updated).toBe(true)
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
  })

  it('fails clearly when the bundled extension is missing', () => {
    expect(() => installExtension(join(root, 'nope'), dest)).toThrow('找不到 Navo 浏览器扩展')
  })
})

describe('installExtension into a folder the user chose', () => {
  it('will not wipe a folder that holds something else', () => {
    const root = mkdtempSync(join(tmpdir(), 'ext-install-'))
    const src = join(root, 'src')
    const dest = join(root, 'Navo 扩展')
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'Navo', version: '0.1.0' }))
    mkdirSync(dest)
    writeFileSync(join(dest, 'notes.txt'), 'mine')
    expect(() => installExtension(src, dest)).toThrow('不是 Navo 扩展')
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('mine')
  })
  it('rejects another extension even when its version matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'ext-install-'))
    const src = join(root, 'src')
    const dest = join(root, 'other')
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'Navo', version: '0.1.0' }))
    mkdirSync(dest)
    const manifest = JSON.stringify({ name: 'Other', version: '0.1.0' })
    writeFileSync(join(dest, 'manifest.json'), manifest)
    writeFileSync(join(dest, 'notes.txt'), 'mine')
    expect(() => installExtension(src, dest)).toThrow('不是 Navo 扩展')
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('mine')
  })
})
