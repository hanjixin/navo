import React from 'react'
import ReactDOM from 'react-dom/client'
import { setLanguage } from '@shared/i18n'
import './styles/globals.css'

// the language is known before the app (and its module-level labels) loads
const lang = await window.api.invoke('app.language').catch(() => 'zh' as const)
setLanguage(lang)
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
const { App } = await import('./App')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
