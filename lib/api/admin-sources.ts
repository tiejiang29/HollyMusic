/**
 * 音源管理 API 客户端
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { SourceConfig } from '@/lib/types/music'
import type { SourceHealthView } from '@/lib/server/source-health'
import type { SourceProbeVerdict } from '@/lib/services/source-manager-service'

export interface AdminSource extends SourceConfig {
  scriptExists: boolean
  /** 运行实测健康度（内存账本，按平台分别；重启清零） */
  health?: SourceHealthView[]
  /** 最近一次周测的结论（落库，跨重启） */
  probe?: SourceProbeVerdict[]
}

export interface ProbeRunStatus {
  id: number
  startedAt: string
  finishedAt: string | null
  trigger: string
  status: string
  total: number
  probed: number
  okCount: number
  badCount: number
  detail: string | null
}

export interface ProbeStatus {
  running: boolean
  last: ProbeRunStatus | null
  disabled?: boolean
}

export function listSources(): Promise<{ list: AdminSource[]; probe?: ProbeStatus }> {
  return apiGet<{ list: AdminSource[]; probe?: ProbeStatus }>('admin/sources')
}

/** 立刻跑一批周测（服务端异步执行，靠 listSources 的 probe 字段轮询进度） */
export function startSourceProbe(): Promise<{ started: boolean }> {
  return apiPost<{ started: boolean }>('admin/sources/probe', {})
}

export function createSource(opts: {
  path: string
  name?: string
  description?: string
  priority?: number
  timeout?: number
  enabled?: boolean
  pt?: string[]
}): Promise<SourceConfig> {
  return apiPost<SourceConfig>('admin/sources', opts)
}

export function updateSource(
  sourcePath: string,
  opts: {
    name?: string
    description?: string
    priority?: number
    timeout?: number
    enabled?: boolean
    pt?: string[]
  }
): Promise<SourceConfig> {
  return apiPut<SourceConfig>(`admin/sources/${encodeURIComponent(sourcePath)}`, opts)
}

export function deleteSource(sourcePath: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`admin/sources/${encodeURIComponent(sourcePath)}`)
}

/** 从在线洛雪链接导入脚本，并注册为可手动更新的订阅。 */
export function importSourceSubscription(url: string): Promise<SourceConfig> {
  return apiPost<SourceConfig>('admin/sources/subscriptions', { url })
}

/** 手动拉取已订阅脚本的最新内容。 */
export function updateSourceSubscription(sourcePath: string): Promise<SourceConfig> {
  return apiPost<SourceConfig>(`admin/sources/${encodeURIComponent(sourcePath)}`)
}

/**
 * 上传音源脚本文件。
 * 成功后自动注册到 music-sources.json。
 */
export async function uploadScript(file: File): Promise<SourceConfig> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch('/api/admin/sources/upload', {
    method: 'POST',
    body: formData,
    // 不要手动设 Content-Type，浏览器会自动加 boundary
  })

  const json = await res.json()
  if (!json.success || json.data === undefined) {
    throw new Error(json.error?.message || '上传失败')
  }
  return json.data as SourceConfig
}
