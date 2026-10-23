import type { ReactNode } from 'react'
import { Empty, Result, Spin } from 'antd'
import { LockOutlined, WarningOutlined } from '@ant-design/icons'

type StateViewProps = {
  /** loading | error | empty | noPerms | locked | ready */
  state: 'loading' | 'error' | 'empty' | 'noPerm' | 'locked' | 'ready'
  children: ReactNode
  errorText?: string
  retry?: () => void
  lockedText?: string
  emptyText?: string
  minHeight?: number
}

/**
 * 数据视图五态包装：加载中 / 错误 / 空态 / 无权限 / 锁定。
 * state = ready 时仅渲染 children（不附加额外容器）。
 */
const StateView = ({
  state,
  children,
  errorText = '加载失败，请稍后重试',
  retry,
  lockedText = '文件已被锁定，当前不可编辑',
  emptyText = '暂无内容',
  minHeight = 320,
}: StateViewProps) => {
  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center bg-card" style={{ minHeight }}>
        <Spin size="large" />
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className="flex items-center justify-center bg-card" style={{ minHeight }}>
        <Result
          status="error"
          icon={<WarningOutlined className="text-error" />}
          title="出错了"
          subTitle={errorText}
          extra={retry ? <button type="button" className="ant-btn ant-btn-primary" onClick={retry}>重试</button> : undefined}
        />
      </div>
    )
  }
  if (state === 'noPerm') {
    return (
      <div className="flex items-center justify-center bg-card" style={{ minHeight }}>
        <Result
          status="403"
          icon={<LockOutlined className="text-warning" />}
          title="无权访问"
          subTitle="你当前没有该资源的访问权限，请联系管理员或目录所有者授权"
        />
      </div>
    )
  }
  if (state === 'locked') {
    return (
      <div className="flex items-center justify-center bg-card" style={{ minHeight }}>
        <Result
          status="warning"
          icon={<LockOutlined className="text-warning" />}
          title="文件已锁定"
          subTitle={lockedText}
        />
      </div>
    )
  }
  if (state === 'empty') {
    return (
      <div className="flex items-center justify-center bg-card" style={{ minHeight }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
      </div>
    )
  }
  return <>{children}</>
}

export default StateView
