import { describe, expect, it } from 'vitest'
import { desktopAppKey, desktopExecutableName, desktopRelativePath, desktopSupported } from '../src/main/desktop/platform'

describe('desktop platform support', () => {
  it('requires macOS 14 (Darwin 23) for real desktop control', () => {
    expect(desktopSupported('darwin', '22.6.0')).toBe(false)
    expect(desktopSupported('darwin', '23.0.0')).toBe(true)
    expect(desktopSupported('darwin', '24.6.0')).toBe(true)
    expect(desktopSupported('darwin', '22.6.0', true)).toBe(true)
  })

  it('supports Windows 10 and newer kernel releases', () => {
    expect(desktopSupported('win32', '6.3.9600')).toBe(false)
    expect(desktopSupported('win32', '10.0.19045')).toBe(true)
    expect(desktopSupported('win32', '10.0.26100')).toBe(true)
  })

  it('does not enable unsupported platforms even in fake mode', () => {
    expect(desktopSupported('linux', '6.12.0')).toBe(false)
    expect(desktopSupported('linux', '6.12.0', true)).toBe(false)
    expect(desktopSupported('freebsd', '14.0', true)).toBe(false)
  })

  it('rejects unrecognizable operating system releases', () => {
    expect(desktopSupported('darwin', '')).toBe(false)
    expect(desktopSupported('win32', 'unknown')).toBe(false)
  })
})

describe('desktop executable paths', () => {
  it('keeps the macOS helper filename and location', () => {
    expect(desktopExecutableName('darwin')).toBe('navo-desktop')
    expect(desktopRelativePath('darwin', 'arm64')).toBe('navo-desktop')
    expect(desktopRelativePath('darwin', 'x64')).toBe('navo-desktop')
  })

  it('uses architecture-specific Windows executable directories', () => {
    expect(desktopExecutableName('win32')).toBe('navo-desktop.exe')
    expect(desktopRelativePath('win32', 'x64').replaceAll('\\', '/')).toBe('win-x64/navo-desktop.exe')
    expect(desktopRelativePath('win32', 'arm64').replaceAll('\\', '/')).toBe('win-arm64/navo-desktop.exe')
  })
})

describe('desktop app identity', () => {
  it('treats Windows path case, separators and dot segments as the same app', () => {
    expect(desktopAppKey('c:/Apps/tool.exe')).toBe(desktopAppKey('C:\\Apps\\folder\\..\\tool.exe'))
    expect(desktopAppKey('C:\\Apps\\other.exe')).not.toBe(desktopAppKey('c:/Apps/tool.exe'))
  })

  it('lowercases macOS bundle IDs without interpreting them as paths', () => {
    expect(desktopAppKey('com.apple.TextEdit')).toBe('com.apple.textedit')
    expect(desktopAppKey('COM.APPLE.TEXTEDIT')).toBe(desktopAppKey('com.apple.TextEdit'))
  })
})
