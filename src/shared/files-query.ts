import type { Artifact, OutputKind, ProjectFileEntry } from './types'

export interface ProjectFileRef {
  projectId: string
  root: string
  path: string
  name?: string
}
export interface ProjectFilePage {
  root: string
  path: string
  entries: ProjectFileEntry[]
  nextCursor: string | null
}
export interface ProjectFileSearchResult {
  root: string
  entries: ProjectFileEntry[]
  truncated: boolean
  cancelled: boolean
}
export interface ArtifactsQuery {
  projectId?: string | null
  threadId?: string
  q?: string
  kind?: OutputKind
  cursor?: string
  limit?: number
}
export interface ArtifactsPage {
  items: Artifact[]
  nextCursor: string | null
}
