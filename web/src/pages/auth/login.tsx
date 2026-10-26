import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Button, ConfigProvider, Form, Input, Switch, Typography, theme as antdTheme } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { client } from '@/api'
import { setAccessToken } from '@/store/token'
import { useAuth, type LoginForm } from '@/store/useAuth'

const { Text } = Typography

/**
 * 登录页（VentoOS 风格）：全屏壁纸上的居中玻璃卡片。
 * 保留首部署 bootstrap 开关；登录失败时卡片抖动 + 行内错误提示。
 */
const LoginPage = () => {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [form] = Form.useForm<LoginForm>()
  const [loading, setLoading] = useState(false)
  const [bootstrapMode, setBootstrapMode] = useState(false)
  const [initForm] = Form.useForm<{ username: string; display_name?: string; password: string }>()
  const [errorMsg, setErrorMsg] = useState('')
  const [shaking, setShaking] = useState(false)

  const shake = () => setShaking(true)

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    setErrorMsg('')
    const user = await login(values)
    setLoading(false)
    if (user) {
      navigate('/')
    } else {
      setErrorMsg('账号或密码错误，请重试')
      shake()
    }
  }

  const onBootstrap = async (values: { username: string; display_name?: string; password: string }) => {
    setLoading(true)
    setErrorMsg('')
    const { error, data } = await client.post('/api/v1/auth/bootstrap', { body: values })
    setLoading(false)
    if (!error && data) {
      setAccessToken(data.token)
      navigate('/')
    } else {
      setErrorMsg('创建失败：系统已存在账号，请直接用上方登录')
      shake()
    }
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: '#4da3ff',
          colorBgContainer: 'rgba(255, 255, 255, 0.08)',
          colorBorder: 'rgba(255, 255, 255, 0.22)',
          colorText: '#f2f4f8',
          colorTextPlaceholder: 'rgba(255, 255, 255, 0.45)',
          borderRadius: 10
        }
      }}
    >
      <div
        className={shaking ? 'vd-login-card vd-login-shake' : 'vd-login-card'}
        onAnimationEnd={() => setShaking(false)}
      >
        <div className="vd-login-logo">V</div>
        <h1 className="vd-login-title">VentoDocs</h1>
        <Text className="vd-login-sub">自部署文档管理系统</Text>

        {errorMsg && <div className="vd-login-error">{errorMsg}</div>}

        <Form
          form={form}
          name="login"
          className="flex flex-col gap-10px mt-16px"
          onFinish={onFinish}
          autoComplete="off"
        >
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]} className="mb-0">
            <Input size="large" placeholder="账号" prefix={<UserOutlined className="opacity-40" />} className="vd-login-input" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} className="mb-0">
            <Input.Password
              size="large"
              placeholder="密码"
              prefix={<LockOutlined className="opacity-40" />}
              className="vd-login-input"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} size="large" className="w-full mt-4px">
            登录
          </Button>
        </Form>

        <div className="vd-login-footer">
          <Text className="text-12px opacity-60">首次部署，还没有账号？</Text>
          <Switch size="small" checked={bootstrapMode} onChange={setBootstrapMode} />
        </div>

        {bootstrapMode && (
          <div className="mt-12px pt-12px border-t border-white/15">
            <Text className="text-12px opacity-70 block mb-10px">创建首个管理员账号（仅系统无任何账号时可用）</Text>
            <Form
              form={initForm}
              className="flex flex-col gap-10px"
              name="bootstrap"
              onFinish={onBootstrap}
              autoComplete="off"
            >
              <Form.Item name="username" rules={[{ required: true, message: '请输入管理员账号' }]} className="mb-0">
                <Input size="large" placeholder="管理员账号" className="vd-login-input" />
              </Form.Item>
              <Form.Item name="display_name" className="mb-0">
                <Input size="large" placeholder="显示名称（可选）" className="vd-login-input" />
              </Form.Item>
              <Form.Item name="password" rules={[{ required: true, min: 8, message: '密码至少 8 位' }]} className="mb-0">
                <Input.Password
                  size="large"
                  placeholder="管理员密码（至少 8 位）"
                  className="vd-login-input"
                  autoComplete="new-password"
                />
              </Form.Item>
              <Button type="primary" danger htmlType="submit" loading={loading} size="large" className="w-full mt-4px">
                创建首个管理员
              </Button>
            </Form>
          </div>
        )}
      </div>
    </ConfigProvider>
  )
}

export default () => (
  <LoginPage />
)
