import {
  CheckOutlined,
  CloudUploadOutlined,
  ExperimentOutlined,
  SaveOutlined,
  UndoOutlined
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Menu,
  Modal,
  Row,
  Segmented,
  Space,
  Spin,
  Switch,
  Tag,
  Typography
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { client } from '@/api'
import { WALLPAPERS } from '@/lib/wallpapers'
import { useAuth } from '@/store/useAuth'
import { useSettings, type ThemeMode } from '@/store/useSettings'
import { msg } from '@/components/GlobalMessage'

const { Text } = Typography

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

/** 外观设置（借鉴 VentoOS 桌面设置）：主题三态 + 内置壁纸库。 */
const AppearanceSection = () => {
  const { themeMode, setThemeMode, wallpaper, setWallpaper } = useSettings()
  return (
    <div className="flex flex-col gap-16px">
      <Card title="主题" size="small">
        <Segmented<ThemeMode>
          value={themeMode}
          onChange={(v) => setThemeMode(v)}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'auto' },
          ]}
        />
      </Card>

      <Card title="壁纸" size="small">
        <p className="text-13px m-0 text-#6B7280">
          壁纸将显示在桌面背景上，内容区为半透明窗口；选择「无」恢复纯色背景。
        </p>
        <div className="grid grid-cols-4 gap-12px mt-12px">
          {WALLPAPERS.map((w) => {
            const selected = wallpaper === w.value
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setWallpaper(w.value)}
                className="relative p-0 border-0 m-0 cursor-pointer bg-transparent"
              >
                <div
                  className={
                    selected
                      ? 'relative rounded-8px ring-2 ring-#2563EB ring-offset-2'
                      : 'relative rounded-8px hover:ring-2 hover:ring-#2563EB/40'
                  }
                >
                  {w.value ? (
                    <img
                      src={w.value}
                      alt={w.name}
                      className="w-full aspect-video object-cover rounded-8px"
                    />
                  ) : (
                    <div className="w-full aspect-video rounded-8px border-1px border-#E5E7EB bg-#F7F8FA flex items-center justify-center text-13px text-#9CA3AF">
                      无
                    </div>
                  )}
                  {selected && (
                    <span className="absolute right-6px bottom-6px bg-#2563EB text-white rounded-full w-18px h-18px flex items-center justify-center">
                      <CheckOutlined className="text-10px" />
                    </span>
                  )}
                </div>
                <div className="text-12px mt-4px text-center text-#4B5563">{w.name}</div>
              </button>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

/** 账户与安全（管理员）：LDAP 在线配置。 */
const LdapSection = () => {
  const [cfg, setCfg] = useState<LdapConfigInfo | null>(null)
  const [cfgMsg, setCfgMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [form] = Form.useForm()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LdapTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<LdapImportResult | null>(null)

  const loadCfg = useCallback(async () => {
    setLoading(true)
    const { error, data, response } = await client.get('/api/v1/users/ldap/config')
    setLoading(false)
    if (!error && data) {
      const info = data as unknown as LdapConfigInfo
      setCfg(info)
      setCfgMsg('')
      form.setFieldsValue({
        host: info.host,
        port: info.port,
        start_tls: info.startTls,
        base_dn: info.baseDn,
        bind_dn: info.bindDn,
        bind_password: '',
        user_filter: info.userFilter,
        attr_username: info.attrUsername,
        attr_name: info.attrName,
        attr_email: info.attrEmail
      })
    } else {
      setCfg(null)
      // 400 = 数据库与环境变量均无配置；其余情况给通用提示（详情已在全局 toast 展示）
      setCfgMsg(response?.status === 400
        ? 'LDAP 未配置（数据库与环境变量均无配置）'
        : 'LDAP 配置加载失败，请重试')
    }
  }, [form])

  useEffect(() => {
    void loadCfg()
  }, [loadCfg])

  const doTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const values = await form.validateFields()
      // host 有值 = 用表单值测试；表单未填 host 时测当前生效配置
      const body = values.host ? { ...values, bind_password: values.bind_password || undefined } : {}
      const { data } = await client.post('/api/v1/users/ldap/test', { body })
      setTestResult((data ?? { ok: false, error: '无响应' }) as unknown as LdapTestResult)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    let values
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    const { error } = await client.put('/api/v1/users/ldap/config', {
      body: { ...values, bind_password: values.bind_password || undefined }
    })
    setSaving(false)
    if (!error) {
      msg.success('LDAP 配置已保存')
      await loadCfg()
    }
  }

  const doImport = () => {
    Modal.confirm({
      title: '从 LDAP 目录导入用户',
      content: '将按当前配置从 LDAP 检索用户并导入（已存在的用户仅同步元数据）。',
      okText: '导入',
      cancelText: '取消',
      onOk: async () => {
        setImporting(true)
        const { error, data } = await client.post('/api/v1/users/ldap/import', { body: {} })
        setImporting(false)
        if (!error && data) {
          setImportResult(data as unknown as LdapImportResult)
        }
      }
    })
  }

  const doReset = () => {
    Modal.confirm({
      title: '恢复环境变量配置',
      content: '删除数据库中的 LDAP 配置，回退到 VIENTO_LDAP_* 环境变量。此操作不可撤销。',
      okText: '恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const { error } = await client.delete('/api/v1/users/ldap/config')
        if (!error) {
          msg.success('已恢复环境变量配置')
          await loadCfg()
        }
      }
    })
  }

  return (
    <div className="flex flex-col gap-16px">
      <Card size="small" title="当前生效配置">
        {loading ? (
          <Spin />
        ) : cfg ? (
          <div className="flex flex-col gap-8px text-13px">
            <div className="flex items-center gap-8px">
              <Text type="secondary">来源：</Text>
              <Tag color={cfg.source === 'database' ? 'blue' : 'green'}>
                {cfg.source === 'database' ? '数据库配置' : '环境变量'}
              </Tag>
              <Text type="secondary">主机：</Text>
              <Text code>
                {cfg.host}:{cfg.port}
                {cfg.startTls ? ' (startTLS)' : ''}
              </Text>
            </div>
            <div>
              <Text type="secondary">Base DN：</Text>
              <Text code>{cfg.baseDn || '—'}</Text>
            </div>
            <div className="flex items-center gap-12px flex-wrap">
              <span>
                <Text type="secondary">Bind DN：</Text>
                <Tag color={cfg.bindDnSet ? 'green' : 'default'}>{cfg.bindDnSet ? '已设置' : '匿名'}</Tag>
              </span>
              <span>
                <Text type="secondary">Bind 密码：</Text>
                <Tag color={cfg.passwordSet ? 'green' : 'default'}>{cfg.passwordSet ? '已设置' : '未设置'}</Tag>
              </span>
              <span>
                <Text type="secondary">过滤器：</Text>
                <Text code>{cfg.userFilter}</Text>
              </span>
            </div>
          </div>
        ) : (
          <Alert type="warning" showIcon message={cfgMsg || 'LDAP 未配置'} description="请通过下方表单配置，或通过 VIENTO_LDAP_* 环境变量提供。" />
        )}
      </Card>

      <Card
        size="small"
        title="LDAP 目录配置"
        extra={
          <Space>
            <Button size="small" icon={<ExperimentOutlined />} loading={testing} onClick={() => void doTest()}>
              测试连接
            </Button>
            <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void doSave()}>
              保存
            </Button>
            <Button size="small" icon={<CloudUploadOutlined />} loading={importing} onClick={doImport}>
              导入用户
            </Button>
            {cfg?.source === 'database' && (
              <Button size="small" danger icon={<UndoOutlined />} onClick={doReset}>
                恢复环境变量
              </Button>
            )}
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ port: 389, start_tls: false }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="host"
                label="主机"
                rules={[{ required: true, message: '请输入 LDAP 主机' }]}
              >
                <Input placeholder="ldap.example.com 或 127.0.0.1" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="port" label="端口" rules={[{ required: true }]}>
                <InputNumber min={1} max={65535} className="w-full" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="start_tls" label="StartTLS" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="base_dn" label="Base DN">
            <Input placeholder="dc=example,dc=com" />
          </Form.Item>
          <Form.Item name="bind_dn" label="Bind DN">
            <Input placeholder="cn=admin,dc=example,dc=com（留空 = 匿名绑定）" />
          </Form.Item>
          <Form.Item name="bind_password" label="Bind 密码">
            <Input.Password
              placeholder={cfg?.passwordSet ? '留空保持不变' : '留空 = 沿用已有密码'}
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item name="user_filter" label="用户过滤器">
            <Input placeholder="(objectClass=inetOrgPerson)" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="attr_username" label="用户名属性">
                <Input placeholder="uid" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="attr_name" label="显示名属性">
                <Input placeholder="cn" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="attr_email" label="邮箱属性">
                <Input placeholder="mail" />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {testResult && (
          <Alert
            className="mt-4"
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            message={
              testResult.ok
                ? `连接成功，发现 ${testResult.entries ?? 0} 个用户`
                : `连接失败：${testResult.error ?? '未知错误'}`
            }
            description={
              testResult.sample && testResult.sample.length > 0 ? (
                <div className="flex flex-col gap-2px text-12px">
                  {testResult.sample.slice(0, 5).map((s) => (
                    <span key={s}>{s}</span>
                  ))}
                </div>
              ) : undefined
            }
          />
        )}
      </Card>

      <Modal
        title="LDAP 导入结果"
        open={!!importResult}
        onCancel={() => setImportResult(null)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setImportResult(null)}>
            完成
          </Button>
        ]}
      >
        {importResult && (
          <div className="flex flex-col gap-8px">
            <p>
              新导入 <Text strong>{importResult.created}</Text> 个，跳过{' '}
              <Text strong>{importResult.skipped}</Text> 个，失败{' '}
              <Text strong>{importResult.failed.length}</Text> 个。
            </p>
            {importResult.failed.length > 0 && (
              <div className="max-h-200 overflow-auto">
                {importResult.failed.map((f) => (
                  <div key={f} className="text-12px text-#FF4D4F">
                    {f}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

/** 关于：版本与组件信息。 */
const AboutSection = () => (
  <Card size="small" title="关于 VentoDocs">
    <div className="flex flex-col gap-10px text-13px">
      <div className="flex items-center gap-12px">
        <div className="w-40px h-40px rounded-8px bg-#2563EB flex items-center justify-center text-white text-18px font-bold">
          V
        </div>
        <div>
          <div className="text-15px font-semibold">VentoDocs</div>
          <Text type="secondary">自部署文档管理系统 · v1.0</Text>
        </div>
      </div>
      <div className="flex flex-col gap-4px text-#6B7280">
        <span>
          后端：Rust（Axum + PostgreSQL）· 前端：React 19 + Ant Design 6
        </span>
        <span>在线编辑：Ranuts 文档编辑器（xlsx / docx / pptx）</span>
        <span>认证：本地账号 + LDAP 目录同步（管理员可在「账户与安全」中在线配置）</span>
      </div>
    </div>
  </Card>
)

const SettingsPage = () => {
  const role = useAuth((s) => s.computed.role)
  const isAdmin = role === 'admin'
  const [section, setSection] = useState<'appearance' | 'security' | 'about'>('appearance')

  const items: { key: 'appearance' | 'security' | 'about'; label: string }[] = [
    { key: 'appearance', label: '外观设置' },
    ...(isAdmin ? [{ key: 'security' as const, label: '账户与安全' }] : []),
    { key: 'about', label: '关于' }
  ]

  return (
    <div className="flex gap-16px items-start">
      <div className="w-160px shrink-0">
        <Menu
          mode="inline"
          selectedKeys={[section]}
          onClick={(e) => setSection(e.key as typeof section)}
          items={[...items]}
          className="bg-transparent border-0 rounded-8px"
        />
      </div>
      <div className="flex-1 min-w-0">
        {section === 'appearance' && <AppearanceSection />}
        {section === 'security' && isAdmin && <LdapSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  )
}

export default SettingsPage
