import { message } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'
import { useEffect } from 'react'

export let msg: MessageInstance

const GlobalMessage = () => {
  const [_msg, messageHolder] = message.useMessage()
  useEffect(() => {
    msg = _msg
  }, [_msg])
  return messageHolder
}

export default GlobalMessage
