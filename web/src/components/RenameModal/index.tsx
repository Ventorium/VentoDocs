import { useState } from 'react'
import { Input, Modal } from 'antd'
import { msg } from '@/components/GlobalMessage'

type RenameModalProps = {
  open: boolean
  title: string
  initialName: string
  submitting?: boolean
  onSubmit: (name: string) => Promise<void>
}

/** 通用重命名弹窗（文件 / 目录共用）。 */
const RenameModal = ({ open, title, initialName, submitting, onSubmit }: RenameModalProps) => {
  const [name, setName] = useState(initialName)

  const handleOk = async () => {
    const next = name.trim()
    if (!next) {
      msg.warning('名称不能为空')
      return
    }
    await onSubmit(next)
  }

  return (
    <Modal
      open={open}
      title={title}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      onCancel={() => setName(initialName)}
      afterOpenChange={(visible) => {
        if (visible) setName(initialName)
      }}
      destroyOnHidden
    >
      <div className="py-4px">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleOk}
          placeholder="输入新名称"
          autoFocus
          maxLength={200}
        />
      </div>
    </Modal>
  )
}

export default RenameModal
