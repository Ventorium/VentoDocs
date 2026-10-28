import { useEffect, useState } from 'react'
import { Btn, Input, Modal } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'

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

  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])

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
      onClose={() => setName(initialName)}
      footer={
        <>
          <Btn onClick={() => setName(initialName)}>取消</Btn>
          <Btn variant="primary" loading={submitting} onClick={() => void handleOk()}>保存</Btn>
        </>
      }
    >
      <div style={{ padding: '8px 0' }}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleOk() }}
          placeholder="输入新名称"
          maxLength={200}
        />
      </div>
    </Modal>
  )
}

export default RenameModal
