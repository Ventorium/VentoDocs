import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, CloudUpload, RotateCcw, Save, Search } from 'lucide-react'
import { client } from '@/api'
import type { LdapConfigUpdate } from '@/api/schema'
import { WALLPAPERS } from '@/lib/wallpapers'
import { useAuth } from '@/store/useAuth'
import { useSettings, type ThemeMode } from '@/store/useSettings'
import { Btn, Seg, Spin, Switch, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'

type LdapConfigInfo = {
  host: string
  port: number
  startTls: boolean
  baseDn: string
  bindDn: string
  userFilter: string
  attrUsername: string
  attrName: string
  attrEmail: string
  source: 'database' | 'env'
  passwordSet: boolean
  bindDnSet: boolean
}

type LdapTestResult = { ok: boolean; entries?: number; error?: string; sample?: string[] }
type LdapImportResult = { created: number; skipped: number; failed: string[] }

type LdapForm = {
  host: string
  port: string
  start_tls: boolean
  base_dn: string
  bind_dn: string
  bind_password: string
  user_filter: string
  attr_username: string
  attr_name: string
  attr_email: string
}

const LDAP_FORM_INIT: LdapForm = {
  host: '',
  port: '389',
  start_tls: false,
  base_dn: '',
  bind_dn: '',
  bind_password: '',
  user_filter: '',
  attr_username: '',
  attr_name: '',
  attr_email: '',
}

/** 通用面板。 */
const Panel = ({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) => (
  <div className="vd-panel">
    <div className="vd-panel-head">
      <span>{title}</span>
      {extra ? <div>{extra}</div> : null}
    </div>
    <div className="vd-panel-body">{children}</div>
  </div>
)

/** 外观设置（借鉴 VentoOS 桌面设置）：主题三态 + 内置壁纸库。 */
const AppearanceSection = () => {
  const { themeMode, setThemeMode, wallpaper, setWallpaper } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="主题">
        <Seg
          value={themeMode}
          onChange={(v) => setThemeMode(v as ThemeMode)}
          options={[
            { key: 'light', label: '浅色' },
            { key: 'dark', label: '深色' },
            { key: 'auto', label: '跟随系统' },
          ]}
        />
      </Panel>

      <Panel title="壁纸">
        <p className="m-0" style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>
          壁纸将显示在桌面背景上，内容区为半透明窗口；选择「无」恢复纯色背景。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 12 }}>
          {WALLPAPERS.map((w) => {
            const selected = wallpaper === w.value
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setWallpaper(w.value)}
                style={{ position: 'relative', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
              >
                <div
                  style={{
                    position: 'relative',
                    borderRadius: 8,
                    outline: selected
                      ? `2px solid var(--vd-accent)`
                      : '2px solid transparent',
                    outlineOffset: 2,
                  }}
                >
                  {w.value ? (
                    <img src={w.value} alt={w.name} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, display: 'block' }} />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        aspectRatio: '16/9',
                        borderRadius: 8,
                        border: '1px solid var(--vd-border-subtle)',
                        background: 'var(--vd-bg-overlay)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 13,
                        color: 'var(--vd-text-tertiary)',
                      }}
                    >
                      无
                    </div>
                  )}
                  {selected ? (
                    <span
                      style={{
                        position: 'absolute',
                        right: 6,
                        bottom: 6,
                        background: 'var(--vd-accent)',
                        color: '#fff',
                        borderRadius: '50%',
                        width: 18,
                        height: 18,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Check size={10} />
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 12, marginTop: 4, textAlign: 'center', color: 'var(--vd-text-secondary)' }}>{w.name}</div>
              </button>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

const Field = ({ label, children, error }: { label: string; children: ReactNode; error?: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span className="vd-field-label">{label}</span>
    {children}
    {error ? <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{error}</span> : null}
  </div>
)

/** 账户与安全（管理员）：LDAP 在线配置。 */
const LdapSection = () => {
  const [cfg, setCfg] = useState<LdapConfigInfo | null>(null)
  const [cfgMsg, setCfgMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<LdapForm>(LDAP_FORM_INIT)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof LdapForm, string>>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LdapTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [importResult, setImportResult] = useState<LdapImportResult | null>(null)
  const [confirm, setConfirm] = useState<'import' | 'reset' | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const setF = <K extends keyof LdapForm>(k: K, v: LdapForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const loadCfg = useCallback(async () => {
    setLoading(true)
    const { error, data, response } = await client.get('/api/v1/users/ldap/config')
    setLoading(false)
    if (!error && data) {
      const info = data as unknown as LdapConfigInfo
      setCfg(info)
      setCfgMsg('')
      setForm({
        host: info.host,
        port: String(info.port),
        start_tls: info.startTls,
        base_dn: info.baseDn,
        bind_dn: info.bindDn,
        bind_password: '',
        user_filter: info.userFilter,
        attr_username: info.attrUsername,
        attr_name: info.attrName,
        attr_email: info.attrEmail,
      })
    } else {
      setCfg(null)
      // 400 = 数据库与环境变量均无配置；其余情况给通用提示（详情已在全局 toast 展示）
      setCfgMsg(
        response?.status === 400 ? 'LDAP 未配置（数据库与环境变量均无配置）' : 'LDAP 配置加载失败，请重试',
      )
    }
  }, [])

  useEffect(() => {
    void loadCfg()
  }, [loadCfg])

  const validate = (): boolean => {
    const errs: Partial<Record<keyof LdapForm, string>> = {}
    if (!form.host.trim()) errs.host = '请输入 LDAP 主机'
    const port = Number(form.port)
    if (form.port.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      errs.port = '请输入 1–65535 的端口'
    }
    setFieldErrors(errs)
    return Object.keys(errs).length === 0
  }

  const buildBody = (withPassword: boolean): LdapConfigUpdate => {
    const v: LdapConfigUpdate = {
      host: form.host.trim(),
      port: Number(form.port),
      start_tls: form.start_tls,
      base_dn: form.base_dn.trim(),
      bind_dn: form.bind_dn.trim(),
      user_filter: form.user_filter.trim(),
      attr_username: form.attr_username.trim(),
      attr_name: form.attr_name.trim(),
      attr_email: form.attr_email.trim(),
    }
    if (withPassword && form.bind_password) v.bind_password = form.bind_password
    return v
  }

  const doTest = async () => {
    setTesting(true)
    setTestResult(null)
    if (!validate()) {
      setTesting(false)
      return
    }
    // host 有值 = 用表单值测试；表单未填 host 时测当前生效配置
    const body = form.host.trim() ? buildBody(false) : {}
    const { data } = await client.post('/api/v1/users/ldap/test', { body })
    setTestResult((data ?? { ok: false, error: '无响应' }) as unknown as LdapTestResult)
    setTesting(false)
  }

  const doSave = async () => {
    if (!validate()) return
    setSaving(true)
    const { error } = await client.put('/api/v1/users/ldap/config', { body: buildBody(true) })
    setSaving(false)
    if (!error) {
      msg.success('LDAP 配置已保存')
      await loadCfg()
    }
  }

  const runImport = async () => {
    setConfirmBusy(true)
    const { error, data } = await client.post('/api/v1/users/ldap/import', { body: {} })
    setConfirmBusy(false)
    setConfirm(null)
    if (!error && data) {
      setImportResult(data as unknown as LdapImportResult)
    }
  }

  const runReset = async () => {
    setConfirmBusy(true)
    const { error } = await client.delete('/api/v1/users/ldap/config')
    setConfirmBusy(false)
    setConfirm(null)
    if (!error) {
      msg.success('已恢复环境变量配置')
      await loadCfg()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="当前生效配置">
        {loading ? (
          <Spin />
        ) : cfg ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--vd-text-secondary)' }}>来源：</span>
              <Tag color={cfg.source === 'database' ? 'blue' : 'green'}>
                {cfg.source === 'database' ? '数据库配置' : '环境变量'}
              </Tag>
              <span style={{ color: 'var(--vd-text-secondary)' }}>主机：</span>
              <code>{cfg.host}:{cfg.port}{cfg.startTls ? ' (startTLS)' : ''}</code>
            </div>
            <div>
              <span style={{ color: 'var(--vd-text-secondary)' }}>Base DN：</span>
              <code>{cfg.baseDn || '—'}</code>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span>
                <span style={{ color: 'var(--vd-text-secondary)' }}>Bind DN：</span>
                <Tag color={cfg.bindDnSet ? 'green' : 'gray'}>{cfg.bindDnSet ? '已设置' : '匿名'}</Tag>
              </span>
              <span>
                <span style={{ color: 'var(--vd-text-secondary)' }}>Bind 密码：</span>
                <Tag color={cfg.passwordSet ? 'green' : 'gray'}>{cfg.passwordSet ? '已设置' : '未设置'}</Tag>
              </span>
              <span>
                <span style={{ color: 'var(--vd-text-secondary)' }}>过滤器：</span>
                <code>{cfg.userFilter}</code>
              </span>
            </div>
          </div>
        ) : (
          <div className="vd-alert vd-alert-warning">
            <div style={{ fontWeight: 600 }}>{cfgMsg || 'LDAP 未配置'}</div>
            <div style={{ fontSize: 12 }}>请通过下方表单配置，或通过 VIENTO_LDAP_* 环境变量提供。</div>
          </div>
        )}
      </Panel>

      <Panel
        title="LDAP 目录配置"
        extra={
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn size="sm" loading={testing} onClick={() => void doTest()}>
              <Search size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              测试连接
            </Btn>
            <Btn size="sm" variant="primary" loading={saving} onClick={() => void doSave()}>
              <Save size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              保存
            </Btn>
            <Btn size="sm" loading={confirmBusy && confirm === 'import'} onClick={() => setConfirm('import')}>
              <CloudUpload size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              导入用户
            </Btn>
            {cfg?.source === 'database' ? (
              <Btn size="sm" variant="danger" onClick={() => setConfirm('reset')}>
                <RotateCcw size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                恢复环境变量
              </Btn>
            ) : null}
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '2 1 220px' }}>
              <Field label="主机" error={fieldErrors.host}>
                <input className="vd-input" placeholder="ldap.example.com 或 127.0.0.1" value={form.host} onChange={(e) => setF('host', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: '1 1 110px' }}>
              <Field label="端口" error={fieldErrors.port}>
                <input className="vd-input" type="number" min={1} max={65535} value={form.port} onChange={(e) => setF('port', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: '1 1 110px' }}>
              <Field label="StartTLS">
                <div style={{ paddingTop: 5 }}>
                  <Switch checked={form.start_tls} onChange={(v) => setF('start_tls', v)} />
                </div>
              </Field>
            </div>
          </div>
          <Field label="Base DN">
            <input className="vd-input" placeholder="dc=example,dc=com" value={form.base_dn} onChange={(e) => setF('base_dn', e.target.value)} />
          </Field>
          <Field label="Bind DN">
            <input className="vd-input" placeholder="cn=admin,dc=example,dc=com（留空 = 匿名绑定）" value={form.bind_dn} onChange={(e) => setF('bind_dn', e.target.value)} />
          </Field>
          <Field label="Bind 密码">
            <input
              className="vd-input"
              type="password"
              placeholder={cfg?.passwordSet ? '留空保持不变' : '留空 = 沿用已有密码'}
              autoComplete="new-password"
              value={form.bind_password}
              onChange={(e) => setF('bind_password', e.target.value)}
            />
          </Field>
          <Field label="用户过滤器">
            <input className="vd-input" placeholder="(objectClass=inetOrgPerson)" value={form.user_filter} onChange={(e) => setF('user_filter', e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 150px' }}>
              <Field label="用户名属性">
                <input className="vd-input" placeholder="uid" value={form.attr_username} onChange={(e) => setF('attr_username', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <Field label="显示名属性">
                <input className="vd-input" placeholder="cn" value={form.attr_name} onChange={(e) => setF('attr_name', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <Field label="邮箱属性">
                <input className="vd-input" placeholder="mail" value={form.attr_email} onChange={(e) => setF('attr_email', e.target.value)} />
              </Field>
            </div>
          </div>
        </div>

        {testResult ? (
          <div
            className={`vd-alert ${testResult.ok ? 'vd-alert-info' : 'vd-alert-danger'}`}
            style={{ marginTop: 12 }}
          >
            <div style={{ fontWeight: 600 }}>
              {testResult.ok
                ? `连接成功，发现 ${testResult.entries ?? 0} 个用户`
                : `连接失败：${testResult.error ?? '未知错误'}`}
            </div>
            {testResult.sample && testResult.sample.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
                {testResult.sample.slice(0, 5).map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Panel>

      {confirm ? (
        <div className="vd-modal-veil" onMouseDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div className="vd-modal" style={{ width: 420 }}>
            <div className="vd-modal-head">
              <span className="vd-modal-title">
                {confirm === 'import' ? '从 LDAP 目录导入用户' : '恢复环境变量配置'}
              </span>
            </div>
            <div className="vd-modal-body">
              {confirm === 'import' ? (
                <p className="m-0">将按当前配置从 LDAP 检索用户并导入（已存在的用户仅同步元数据）。</p>
              ) : (
                <p className="m-0">删除数据库中的 LDAP 配置，回退到 VIENTO_LDAP_* 环境变量。此操作不可撤销。</p>
              )}
            </div>
            <div className="vd-modal-foot">
              <Btn onClick={() => setConfirm(null)}>取消</Btn>
              <Btn
                variant={confirm === 'reset' ? 'danger' : 'primary'}
                loading={confirmBusy}
                onClick={() => void (confirm === 'import' ? runImport() : runReset())}
              >
                {confirm === 'import' ? '导入' : '恢复'}
              </Btn>
            </div>
          </div>
        </div>
      ) : null}

      {importResult ? (
        <div className="vd-modal-veil" onMouseDown={(e) => e.target === e.currentTarget && setImportResult(null)}>
          <div className="vd-modal" style={{ width: 420 }}>
            <div className="vd-modal-head">
              <span className="vd-modal-title">LDAP 导入结果</span>
            </div>
            <div className="vd-modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p className="m-0">
                  新导入 <strong>{importResult.created}</strong> 个，跳过 <strong>{importResult.skipped}</strong> 个，失败{' '}
                  <strong>{importResult.failed.length}</strong> 个。
                </p>
                {importResult.failed.length > 0 ? (
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {importResult.failed.map((f) => (
                      <div key={f} style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>
                        {f}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="vd-modal-foot">
              <Btn variant="primary" onClick={() => setImportResult(null)}>
                完成
              </Btn>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 关于：版本与组件信息。 */
const AboutSection = () => (
  <Panel title="关于 VentoDocs">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: 'var(--vd-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          V
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>VentoDocs</div>
          <div style={{ color: 'var(--vd-text-secondary)' }}>自部署文档管理系统 · v1.0</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--vd-text-secondary)' }}>
        <span>后端：Rust（Axum + PostgreSQL）· 前端：React 19 + 自研 UI 组件</span>
        <span>在线编辑：Ranuts 文档编辑器（xlsx / docx / pptx）</span>
        <span>认证：本地账号 + LDAP 目录同步（管理员可在「账户与安全」中在线配置）</span>
      </div>
    </div>
  </Panel>
)

const SettingsPage = () => {
  const role = useAuth((s) => s.computed.role)
  const isAdmin = role === 'admin'
  const [section, setSection] = useState<'appearance' | 'security' | 'about'>('appearance')

  const items: { key: 'appearance' | 'security' | 'about'; label: string }[] = [
    { key: 'appearance', label: '外观设置' },
    ...(isAdmin ? [{ key: 'security' as const, label: '账户与安全' }] : []),
    { key: 'about', label: '关于' },
  ]

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ width: 160, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => setSection(it.key)}
            style={{
              textAlign: 'left',
              padding: '8px 12px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13.5,
              background: section === it.key ? 'rgba(127,127,127,0.16)' : 'transparent',
              color: 'var(--vd-text-primary)',
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {section === 'appearance' ? <AppearanceSection /> : null}
        {section === 'security' && isAdmin ? <LdapSection /> : null}
        {section === 'about' ? <AboutSection /> : null}
      </div>
    </div>
  )
}

export default SettingsPage
