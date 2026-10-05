/**
 * 剪贴板：能写就写，不能写就告诉调用方"请手动选中"。
 *
 * 必须显式处理"不能写"这一档：管理面板在生产上是 **明文 HTTP**（NAS 局域网直连），
 * 而非安全上下文里浏览器压根不挂 `navigator.clipboard`。若只写 happy path，
 * 那个复制按钮在真实环境里是个按了没反应的死控件 —— 比没有按钮更糟。
 */

export type CopyResult = 'copied' | 'manual'

interface ClipboardLike {
  writeText?: (text: string) => Promise<void>
}

export async function copyAddress(rawUrl: string, clipboard?: ClipboardLike | null): Promise<CopyResult> {
  if (!clipboard?.writeText) return 'manual'
  try {
    await clipboard.writeText(rawUrl)
    return 'copied'
  } catch {
    // 权限被拒（用户没给浏览器授权）与"根本没有这个 API"要走同一条降级路
    return 'manual'
  }
}
