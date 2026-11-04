import { join, win32 } from 'node:path'

export function desktopSupported(platform: string, release: string, fake = false): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false
  const major = Number.parseInt(release.split('.')[0], 10)
  return fake || (Number.isFinite(major) && major >= (platform === 'darwin' ? 23 : 10))
}

export const desktopExecutableName = (platform: string): string => (platform === 'win32' ? 'navo-desktop.exe' : 'navo-desktop')

export const desktopRelativePath = (platform: string, arch: string): string =>
  platform === 'win32' ? join(`win-${arch}`, desktopExecutableName(platform)) : desktopExecutableName(platform)

/** Windows app identities are executable paths; separators and case must not change a deny decision. */
export const desktopAppKey = (identity: string): string => (win32.isAbsolute(identity) ? win32.normalize(identity) : identity).toLowerCase()
