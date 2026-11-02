/**
 * WebDAV 挂载帮助（M2.44）。
 *
 * 后端在 `/dav` 暴露同源 WebDAV 入口，根目录固定三个顶级目录：
 *   个人 / 团队 / 分享给我（另有 ASCII 别名 personal / team / shared）。
 * 这里只做展示与复制，不发起任何请求；入口由「文件管理器顶栏按钮」和
 * 「系统设置 → 客户端挂载」共用。
 */
import type { ReactNode } from 'react'
import { Copy, ShieldAlert } from 'lucide-react'
import { Btn, Modal } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { useAuth } from '@/store/useAuth'

/** WebDAV 入口地址：同源 `/dav`（路径区分大小写）。 */
export function WebdavUrl(): string {
  return `${window.location.origin}/dav`
}

const CODE_STYLE: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--vd-bg-overlay)',
  border: '1px solid var(--vd-border-subtle)',
  whiteSpace: 'nowrap',
}

const Code = ({ children }: { children: ReactNode }) => <code style={CODE_STYLE}>{children}</code>

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: 0.2,
      color: 'var(--vd-text-tertiary)',
      textTransform: 'uppercase',
      marginBottom: 6,
    }}
  >
    {children}
  </div>
)

const StepList = ({ steps }: { steps: ReactNode[] }) => (
  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9, color: 'var(--vd-text-secondary)' }}>
    {steps.map((s, i) => (
      <li key={i}>{s}</li>
    ))}
  </ol>
)

/** 复制地址（HTTP 下 clipboard 可能不可用，失败时提示手动复制）。 */
async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    msg.success('WebDAV 地址已复制')
  } catch {
    msg.error('复制失败，请手动选择地址后复制')
  }
}

/**
 * 帮助正文：地址 + 用户名 + Windows/macOS/Linux 步骤 + 顶级目录说明 + 安全提示。
 * 弹窗与设置页共用同一份内容，避免文案两处漂移。
 */
export function WebdavHelpContent() {
  const user = useAuth((s) => s.user)
  const url = WebdavUrl()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 地址 + 用户名 */}
      <div
        style={{
          border: '1px solid var(--vd-border-subtle)',
          borderRadius: 8,
          background: 'var(--vd-bg-overlay)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>WebDAV 地址</span>
          <Code>{url}</Code>
          <Btn size="xs" onClick={() => void copyUrl(url)} title="复制 WebDAV 地址">
            <Copy size={12} style={{ marginRight: 4, verticalAlign: '-1px' }} />
            复制
          </Btn>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--vd-text-secondary)' }}>
          登录用户名：
          <Code>{user?.username ?? '（登录后可见）'}</Code>
          <span style={{ marginLeft: 6 }}>密码为同一次登录使用的密码（LDAP 用户使用目录密码）。</span>
        </div>
      </div>

      {/* 三类顶级目录 */}
      <div>
        <SectionTitle>根目录结构</SectionTitle>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {['个人', '团队', '分享给我'].map((n) => (
            <span
              key={n}
              style={{
                fontSize: 12,
                padding: '3px 8px',
                borderRadius: 999,
                border: '1px solid var(--vd-border-subtle)',
                background: 'var(--vd-bg-item-hover)',
              }}
            >
              {n}
            </span>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.8, color: 'var(--vd-text-secondary)' }}>
          WebDAV 根目录下固定这三个顶级目录，另有 ASCII 别名 <Code>personal</Code> / <Code>team</Code> /{' '}
          <Code>shared</Code> 指向同一目录。<Code>个人</Code> 是自己的文件，
          <Code>团队</Code> 是共享给它所属团队的目录，<Code>分享给我</Code> 是别人直接共享给它的目录；
          挂载后可像本地目录一样读写，权限与配额限制与网页端一致。
        </p>
      </div>

      {/* 各系统步骤 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <SectionTitle>Windows</SectionTitle>
          <StepList
            steps={[
              <>
                打开「文件资源管理器」→ 右键「此电脑」→「映射网络驱动器」，或直接使用命令行{' '}
                <Code>net use Z: {url}</Code>。
              </>,
              <>
                地址填写 <Code>{url}</Code>（也可以用 <Code>http://主机:端口/dav</Code> 的形式）。
              </>,
              <>如提示凭据，输入上面的登录用户名与密码；勾选「记住凭据」可避免每次输入。</>,
            ]}
          />
        </div>
        <div>
          <SectionTitle>macOS Finder</SectionTitle>
          <StepList
            steps={[
              <>在 Finder 中「前往」→「连接服务器」（快捷键 <Code>⌘K</Code>）。</>,
              <>
                输入 <Code>{url}</Code>（或 <Code>http://主机:端口/dav</Code>），点击「连接」。
              </>,
              <>选择「注册用户」，填写登录用户名与密码后即可在 Finder 中浏览挂载目录。</>,
            ]}
          />
        </div>
        <div>
          <SectionTitle>Linux / GNOME</SectionTitle>
          <StepList
            steps={[
              <>
                在文件管理器中选择「其他位置」→「连接服务器」，输入{' '}
                <Code>dav://主机:端口/dav</Code>（或 <Code>{url}</Code>），再填写用户名与密码。
              </>,
              <>
                命令行挂载（davfs2）：<Code>sudo mount -t davfs {url} /mnt/vento</Code>
                ，按提示输入用户名与密码。
              </>,
              <>卸载：<Code>sudo umount /mnt/vento</Code>；如需开机自动挂载，请把凭据写入 davfs2 的 secrets 文件。</>,
            ]}
          />
        </div>
      </div>

      {/* 安全提示 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--vd-warning, #d97706)',
          background: 'rgba(217, 119, 6, 0.08)',
          fontSize: 12.5,
          lineHeight: 1.7,
          color: 'var(--vd-text-secondary)',
        }}
      >
        <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--vd-warning, #d97706)' }} />
        <span>
          推荐在局域网 / 受信网络内使用；公网访问请先通过 HTTPS 反向代理，再以 HTTPS 地址挂载，避免账号密码与文件内容在明文连接中传输。
        </span>
      </div>
    </div>
  )
}

/** 弹窗形态：从文件管理器顶栏打开。 */
export function WebdavHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="挂载到本地（WebDAV）" onClose={onClose} width={620}>
      {/* 帮助内容较长：容器内滚动，避免超出窗口后被焦点层裁切（设置页里不需要） */}
      <div style={{ maxHeight: 'min(56vh, 480px)', overflowY: 'auto', paddingRight: 4 }}>
        <WebdavHelpContent />
      </div>
    </Modal>
  )
}
