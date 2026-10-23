import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

const IndexPage = () => {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    navigate('/app', { replace: true })
  }, [location.pathname])
  return null
}

export default IndexPage
