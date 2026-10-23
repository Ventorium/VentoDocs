import { Alert, Button, Form, Input, Switch, Typography } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { client } from '@/api'
import { setAccessToken } from '@/store/token'
import { useAuth, type LoginForm } from '@/store/useAuth'

const { Text } = Typography

const LoginPage = () => {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [form] = Form.useForm<LoginForm>()
  const [loading, setLoading] = useState(false)
  const [bootstrapMode, setBootstrapMode] = useState(false)
  const [initForm] = Form.useForm<{ username: string; display_name?: string; password: string }>()

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    const user = await login(values)
    setLoading(false)
    if (user) {
      navigate('/')
    }
  }

  const onBootstrap = async (values: { username: string; display_name?: string; password: string }) => {
    setLoading(true)
    const { error, data } = await client.post('/api/v1/auth/bootstrap', { body: values })
    setLoading(false)
    if (!error && data) {
      setAccessToken(data.token)
      navigate('/')
    }
  }

  return (
    <div className="w-120 bg-white/90 backdrop-blur-sm rounded-lg shadow-xl p-8">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-dark">VentoKnowledge</h1>
        <Text type="secondary">文档管理系统</Text>
      </div>

      <Form
        form={form}
        className="flex flex-col gap-3"
        name="login"
        onFinish={onFinish}
        autoComplete="off"
        layout="vertical"
      >
        <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="请输入账号" size="large" />
        </Form.Item>

        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="请输入密码" size="large" />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} size="large" className="w-full">
            登录
          </Button>
        </Form.Item>
      </Form>

      <div className="flex items-center justify-between mt-4">
        <Text type="secondary" className="text-sm">首次部署，还没有账号？</Text>
        <Switch size="small" checked={bootstrapMode} onChange={setBootstrapMode} />
      </div>

      {bootstrapMode && (
        <div className="mt-4 pt-4 border-t">
          <Alert type="info" showIcon message="创建首个管理员账号（仅系统无任何账号时可用）" className="mb-3" />
          <Form
            form={initForm}
            className="flex flex-col gap-3"
            name="bootstrap"
            onFinish={onBootstrap}
            autoComplete="off"
            layout="vertical"
          >
            <Form.Item name="username" rules={[{ required: true, message: '请输入管理员账号' }]}>
              <Input placeholder="管理员账号" size="large" />
            </Form.Item>
            <Form.Item name="display_name">
              <Input placeholder="显示名称（可选）" size="large" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}>
              <Input.Password placeholder="管理员密码（至少 8 位）" size="large" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} size="large" className="w-full" danger>
                创建首个管理员
              </Button>
            </Form.Item>
          </Form>
        </div>
      )}
    </div>
  )
}

export default LoginPage
