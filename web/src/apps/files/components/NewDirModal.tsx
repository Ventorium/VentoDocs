import { useEffect, useState } from 'react'
import { Btn, Input, Modal } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'

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
      onClose={() => setName('')}
      footer={
        <>
          <Btn onClick={() => setName('')}>取消</Btn>
          <Btn variant="primary" loading={submitting} onClick={() => void handleOk()}>创建</Btn>
        </>
      }
    >
      <div style={{ padding: '8px 0' }}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleOk() }}
          placeholder="输入目录名称"
          maxLength={200}
        />
      </div>
    </Modal>
  )
}

export default NewDirModal
