/**
 * 音源脚本上传 API（仅管理员）
 * POST /api/admin/sources/upload   multipart/form-data: { file: File }
 *
 * 流程：
 * 1. 校验文件扩展名 .js + 大小上限
 * 2. 读取内容，用 LXEnvironmentSimulator 预校验（executeScript 同步等待 inited）
 * 3. 校验通过 → saveScript 保存到 custom-sources/
 * 4. 自动注册到 music-sources.json（enabled=true, pt=脚本声明的平台）
 * 5. 返回新源配置
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse } from '@/lib/api-response'
import {
  requireAdmin,
  AuthError,
  ForbiddenError,
} from '@/lib/services/user-context'
import {
  addSource,
  buildMetaFilename,
  extractPlatforms,
  isMojibakeName,
  parseScriptMeta,
  saveScript,
  validateScriptContent,
  SOURCE_MANAGER_CONSTANTS,
} from '@/lib/services/source-manager-service'
import { logger } from '@/lib/logger'

function guard(err: unknown) {
  if (err instanceof AuthError) return createErrorResponse('UNAUTHORIZED', err.message, 401)
  if (err instanceof ForbiddenError) return createErrorResponse('FORBIDDEN', err.message, 403)
  return null
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)

    const formData = await request.formData()
    const file = formData.get('file')

    if (!file || !(file instanceof File)) {
      return createErrorResponse('INVALID_PARAMS', '缺少上传文件: file', 400)
    }

    // 扩展名校验
    if (!file.name.toLowerCase().endsWith('.js')) {
      return createErrorResponse('INVALID_PARAMS', '仅支持 .js 文件', 400)
    }

    // 大小校验
    if (file.size > SOURCE_MANAGER_CONSTANTS.MAX_SCRIPT_SIZE) {
      return createErrorResponse(
        'FILE_TOO_LARGE',
        `文件过大（${(file.size / 1024 / 1024).toFixed(2)}MB），上限 ${SOURCE_MANAGER_CONSTANTS.MAX_SCRIPT_SIZE / 1024 / 1024}MB`,
        400
      )
    }

    // 读取内容
    const content = await file.text()

    // 预校验：用模拟器试加载
    logger.info(`[upload] 校验脚本: ${file.name} (${file.size} bytes)`)
    const validation = await validateScriptContent(content)
    if (!validation.ok) {
      logger.warn(`[upload] 脚本校验失败: ${file.name} - ${validation.error}`)
      return createErrorResponse(
        'SCRIPT_INVALID',
        `脚本校验失败：${validation.error || '未知错误'}`,
        422
      )
    }

    // 保存脚本文件。
    // 文件名经 multipart 传输，非浏览器客户端（如 GBK 终端下的 curl）可能送来
    // 已损坏的乱码文件名（U+FFFD，不可逆）；此时改用脚本头部 @name/@version 元数据命名。
    const meta = parseScriptMeta(content)
    const uploadName = isMojibakeName(file.name) ? buildMetaFilename(meta) : file.name
    if (uploadName !== file.name) {
      logger.warn(`[upload] 上传文件名含乱码，改用脚本元数据命名: ${file.name} → ${uploadName}`)
    }
    const relativePath = await saveScript(uploadName, content)

    // 自动注册到配置（pt 从 sourceInfo 提取；源名称优先脚本声明，其次上传文件名。
    // 文件名乱码时 uploadName 已是元数据名，取其去后缀形式）
    const pt = extractPlatforms(validation.sourceInfo as Record<string, unknown> | undefined)
    const scriptName = (validation.sourceInfo as { name?: string } | undefined)?.name
    const scriptDesc = (validation.sourceInfo as { description?: string } | undefined)?.description
    const displayName = scriptName || uploadName.replace(/\.js$/i, '')

    const newSource = await addSource({
      path: relativePath,
      name: displayName,
      description: scriptDesc,
      enabled: true,
      pt,
    })

    logger.info(`[upload] 脚本上传成功: ${file.name} → ${relativePath}`)
    return createSuccessResponse(newSource, 201)
  } catch (err) {
    const g = guard(err)
    if (g) return g
    logger.error('[api/admin/sources/upload POST] error:', err)
    return createErrorResponse('INTERNAL_ERROR', '上传脚本失败', 500)
  }
}
