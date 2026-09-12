/**
 * 上游平台请求的原生 http/https 工具。
 *
 * 部分上游（如 kw getTagList、wy playlist/list）对服务进程内的 undici fetch
 * 返回空（独立进程/浏览器正常，未定位根因），需要用 node 原生模块绕开。
 */

import http from 'node:http'
import https from 'node:https'

const REQUEST_TIMEOUT = 8_000

/** 原生 http GET JSON（绕开 undici fetch）。 */
export function nativeGetJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: REQUEST_TIMEOUT }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T) }
        catch (e) { reject(e instanceof Error ? e : new Error('JSON 解析失败')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 原生 https POST 表单（绕开 undici fetch：进程内对照实验用）。 */
export function httpsPostForm<T>(url: string, body: string, headers: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: REQUEST_TIMEOUT }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T) }
        catch (e) { reject(e instanceof Error ? e : new Error('JSON 解析失败')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
