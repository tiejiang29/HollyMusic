/**
 * 前端 API 客户端封装
 * 统一处理 /api/* 的 GET/POST/PATCH/DELETE，自动解析 ApiResponse<T>。
 */

import type { ApiResponse } from '@/lib/types/music'

/**
 * 「会话已失效」的处置由 hooks/useAuth 注册，这里不直接 import store：
 * useAuth → lib/api/auth → lib/api/client → useAuth 会成环。
 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

function buildQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const pairs: [string, string][] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') pairs.push([k, String(v)])
  }
  if (pairs.length === 0) return ''
  return '?' + new URLSearchParams(pairs).toString()
}

async function parseJson<T>(res: Response): Promise<T> {
  // 先看状态再看 body：nginx 502 直接回 HTML，以前 `await res.json()` 抛
  // SyntaxError，用户弹到的是 "Unexpected token '<'…" 这种解析器原文。
  const text = await res.text().catch(() => '')
  let payload: ApiResponse<T> | null = null
  try {
    payload = JSON.parse(text) as ApiResponse<T>
  } catch {
    payload = null
  }

  // 401 = 服务端不认这枚会话（如该账号在别处改了密码），当场掉登录态，
  // 不等下一次心跳（最长 2 分钟）才把人踢出去
  if (res.status === 401) unauthorizedHandler?.()

  if (payload && payload.success === true && payload.data !== undefined) return payload.data
  if (payload?.error?.message) throw new Error(payload.error.message)
  throw new Error(res.ok ? '服务端返回了无法解析的内容' : `请求失败（HTTP ${res.status}）`)
}

export async function apiGet<T>(
  url: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const res = await fetch(`/api/${url}${buildQuery(params)}`)
  return parseJson<T>(res)
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiDelete<T>(
  url: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const res = await fetch(`/api/${url}${buildQuery(params)}`, { method: 'DELETE' })
  return parseJson<T>(res)
}
