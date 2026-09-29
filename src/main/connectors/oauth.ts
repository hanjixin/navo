import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { secrets } from '../core/secrets'

/** Loopback redirect (RFC 8252) — works in dev and packaged builds without protocol registration. */
export const OAUTH_PORT = 38765
export const REDIRECT_URL = `http://127.0.0.1:${OAUTH_PORT}/oauth/callback`

type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string }

export class StoredOAuthProvider implements OAuthClientProvider {
  constructor(private readonly key: string) {}

  private load(): Stored {
    const raw = secrets.get(`oauth:${this.key}`)
    return raw ? (JSON.parse(raw) as Stored) : {}
  }

  private patch(p: Partial<Stored>): void {
    secrets.set(`oauth:${this.key}`, JSON.stringify({ ...this.load(), ...p }))
  }

  get redirectUrl(): string {
    return REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Navo',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation() {
    return this.load().client
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.patch({ client: info })
  }
  tokens() {
    return this.load().tokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.patch({ tokens })
  }
  redirectToAuthorization(url: URL) {
    void shell.openExternal(url.toString())
  }
  saveCodeVerifier(verifier: string) {
    this.patch({ verifier })
  }
  codeVerifier() {
    const v = this.load().verifier
    if (!v) throw new Error('缺少 PKCE code verifier')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') secrets.delete(`oauth:${this.key}`)
    else if (scope === 'client') this.patch({ client: undefined })
    else if (scope === 'tokens') this.patch({ tokens: undefined })
    else if (scope === 'verifier') this.patch({ verifier: undefined })
  }
  clear() {
    secrets.delete(`oauth:${this.key}`)
  }
}

/** Waits for a single authorization code on the loopback redirect. */
export function waitForAuthCode(timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null
    const finish = (err: Error | null, code?: string) => {
      clearTimeout(timer)
      server?.close()
      if (err) reject(err)
      else resolve(code!)
    }
    const timer = setTimeout(() => finish(new Error('授权超时')), timeoutMs)
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URL)
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<html><body style="font-family:system-ui;background:#0B1220;color:#E6EAF0;display:grid;place-items:center;height:100vh;margin:0">
          <div style="text-align:center"><h2 style="font-weight:600">${code ? '授权成功' : '授权失败'}</h2>
          <p style="color:#8A94A6">${code ? '可以关闭此页面并返回 Navo。' : (error ?? '')}</p></div></body></html>`,
      )
      finish(code ? null : new Error(error ?? '授权失败'), code ?? undefined)
    })
    server.on('error', (e) => finish(e))
    server.listen(OAUTH_PORT, '127.0.0.1')
  })
}
