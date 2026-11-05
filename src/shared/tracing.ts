export interface TracingIntegrationStatus {
  langsmith: { state: 'disabled' | 'ready' | 'unconfigured' | 'error'; error?: string }
  langfuse: { state: 'disabled' | 'ready' | 'unconfigured' | 'error'; error?: string }
}
