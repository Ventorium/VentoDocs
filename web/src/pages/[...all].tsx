import { Navigate } from 'react-router'

/**
 * WebOS 只有 `/` 一个路由：应用通过窗口管理器打开，不通过 URL。
 * 其余路径一律重定向回桌面（旧 /app/* 地址兼容）。
 */
const CatchAllPage = () => {
  return <Navigate to="/" replace />
}

export default CatchAllPage
