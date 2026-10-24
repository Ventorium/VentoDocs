import { useLocation, Outlet } from 'react-router'
import DirectoryView from './files/components/DirectoryView'

/** 根目录（文件管理首页），同时作为 /app/files/:id 的父级布局。 */
const FilesIndex = () => {
  const { pathname } = useLocation()
  // 仅在 /app/files（根目录）时直接渲染根视图；
  // 其余情况渲染 <Outlet/>，让子路由 files/[id].tsx 显示子目录内容。
  const isIndex = /^\/app\/files\/?$/.test(pathname)
  if (isIndex) return <DirectoryView dirId={null} />
  return <Outlet />
}

export default FilesIndex
