import { useEffect, useState } from 'react'
import { Input, Modal } from 'antd'
import { msg } from '@/components/GlobalMessage'

type NewDirModalProps = {
  open: boolean
  submitting?: boolean
  onSubmit: (name: string) => Promise<void>
}

/** 新建目录弹窗。 */
const NewDirModal = ({ open, submitting, onSubmit }: NewDirModalProps) => {
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) setName('')
  }, [open])

  const handleOk = async () => {
    const next = name.trim()
    if (!next) {
      msg.warning('目录名不能为空')
      return
    }
    await onSubmit(next)
  }

  return (
    <Modal
      open={open}
      title="新建目录"
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      destroyOnHidden
    >
      <div className="py-4px">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleOk}
          placeholder="输入目录名称"
          autoFocus
          maxLength={200}
        />
      </div>
    </Modal>
  )
}

export default NewDirModal
