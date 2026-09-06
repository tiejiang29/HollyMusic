import { createSuccessResponse } from '@/lib/api-response'
import { APP_VERSION } from '@/lib/version'

/**
 * 版本 API（公开，无鉴权）：登录页等未登录界面也能显示当前版本。
 * GET /api/version → { version: "0.23.0" }
 */
export async function GET() {
  return createSuccessResponse({ version: APP_VERSION })
}
