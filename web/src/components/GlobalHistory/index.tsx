import { type NavigateFunction, useNavigate } from 'react-router'

export let globalNavigate: NavigateFunction

const GlobalHistory = () => {
  globalNavigate = useNavigate()

  return null
}

export default GlobalHistory
