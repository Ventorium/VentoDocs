import type { ReactNode } from 'react'
import { Btn, Empty, Spin } from '@/components/ui/kit'

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

function Center({ children, minHeight }: { children: ReactNode; minHeight: number }) {
  return (
    <div className="vd-flex-center" style={{ minHeight, alignItems: 'center', flexDirection: 'column', gap: 8 }}>
      {children}
    </div>
  )
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
      <Center minHeight={minHeight}>
        <Spin large />
      </Center>
    )
  }
  if (state === 'error') {
    return (
      <Center minHeight={minHeight}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>出错了</div>
        <div className="vd-faint" style={{ fontSize: 12.5 }}>{errorText}</div>
        {retry ? <Btn onClick={retry}>重试</Btn> : null}
      </Center>
    )
  }
  if (state === 'noPerm') {
    return (
      <Center minHeight={minHeight}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>无权访问</div>
        <div className="vd-faint" style={{ fontSize: 12.5 }}>你当前没有该资源的访问权限，请联系管理员或目录所有者授权</div>
      </Center>
    )
  }
  if (state === 'locked') {
    return (
      <Center minHeight={minHeight}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>文件已锁定</div>
        <div className="vd-faint" style={{ fontSize: 12.5 }}>{lockedText}</div>
      </Center>
    )
  }
  if (state === 'empty') {
    return (
      <Center minHeight={minHeight}>
        <Empty text={emptyText} />
      </Center>
    )
  }
  return <>{children}</>
}

export default StateView
