export interface ExternalViewState {
  status: 'connecting' | 'live' | 'disconnected' | 'released' | 'error'
  tabId: number | null
  browser: string | null
  title: string
  url: string
  error?: string
}
