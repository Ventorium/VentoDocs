/**
 * M2.23：带回退的剪贴板复制。
 * 优先 navigator.clipboard（安全上下文 + 用户手势）；当它不可用（部分 WebView/
 * 非安全上下文下 undefined）或写入被拒时，回退到隐藏 textarea + execCommand('copy')。
 * 返回是否复制成功，由调用方提示「已复制 / 复制失败请手动复制」。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 写入被拒（权限/非手势上下文）→ 走回退路径
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
