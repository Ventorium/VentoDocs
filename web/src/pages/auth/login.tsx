import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Lock, User } from 'lucide-react'
import { client } from '@/api'
import { setAccessToken } from '@/store/token'
import { useAuth } from '@/store/useAuth'
import { Switch } from '@/components/ui/kit'

/**
 * 登录页（VentoOS 风格）：全屏壁纸上的居中玻璃卡片。
 * 保留首部署 bootstrap 开关；登录失败时卡片抖动 + 行内错误提示。
 */
const LoginPage = () => {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [loading, setLoading] = useState(false)
  const [bootstrapMode, setBootstrapMode] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [shaking, setShaking] = useState(false)

  const [bootUser, setBootUser] = useState('')
  const [bootDisplay, setBootDisplay] = useState('')
  const [bootPwd, setBootPwd] = useState('')

  const shake = () => setShaking(true)

  const doLogin = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!username.trim() || !password) {
      setErrorMsg('请输入账号和密码')
      shake()
      return
    }
    setLoading(true)
    setErrorMsg('')
    const user = await login({ username: username.trim(), password })
    setLoading(false)
    if (user) {
      navigate('/')
    } else {
      setErrorMsg('账号或密码错误，请重试')
      shake()
    }
  }

  const doBootstrap = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!bootUser.trim() || bootPwd.length < 8) {
      setErrorMsg('请填写管理员账号和至少 8 位的密码')
      shake()
      return
    }
    setLoading(true)
    setErrorMsg('')
    const body: { username: string; display_name?: string; password: string } = {
      username: bootUser.trim(),
      password: bootPwd,
    }
    if (bootDisplay.trim()) body.display_name = bootDisplay.trim()
    const { error, data } = await client.post('/api/v1/auth/bootstrap', { body })
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
    <div
      className={shaking ? 'vd-login-card vd-login-shake' : 'vd-login-card'}
      onAnimationEnd={() => setShaking(false)}
    >
      <div className="vd-login-logo">V</div>
      <h1 className="vd-login-title">VentoDocs</h1>
      <span className="vd-login-sub">自部署文档管理系统</span>

      {errorMsg ? <div className="vd-login-error">{errorMsg}</div> : null}

      <form
        className="flex flex-col gap-10px mt-16px"
        autoComplete="off"
        onSubmit={(e) => void doLogin(e)}
      >
        <div className="vd-login-field">
          <User size={15} />
          <input
            className="vd-login-input"
            placeholder="账号"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div className="vd-login-field">
          <Lock size={15} />
          <input
            className="vd-login-input"
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button
          type="submit"
          className="vd-login-btn"
          disabled={loading}
        >
          {loading ? '登录中…' : '登录'}
        </button>
      </form>

      <div className="vd-login-footer">
        <span className="text-12px opacity-60">首次部署，还没有账号？</span>
        <Switch checked={bootstrapMode} onChange={setBootstrapMode} />
      </div>

      {bootstrapMode ? (
        <div className="vd-login-div">
          <span className="text-12px opacity-70 block mb-10px">
            创建首个管理员账号（仅系统无任何账号时可用）
          </span>
          <form className="flex flex-col gap-10px" autoComplete="off" onSubmit={(e) => void doBootstrap(e)}>
            <div className="vd-login-field">
              <User size={15} />
              <input
                className="vd-login-input"
                placeholder="管理员账号"
                value={bootUser}
                onChange={(e) => setBootUser(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="vd-login-field">
              <User size={15} />
              <input
                className="vd-login-input"
                placeholder="显示名称（可选）"
                value={bootDisplay}
                onChange={(e) => setBootDisplay(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="vd-login-field">
              <Lock size={15} />
              <input
                className="vd-login-input"
                type="password"
                placeholder="管理员密码（至少 8 位）"
                value={bootPwd}
                onChange={(e) => setBootPwd(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="vd-login-btn danger" disabled={loading}>
              {loading ? '创建中…' : '创建首个管理员'}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  )
}

export default () => <LoginPage />
