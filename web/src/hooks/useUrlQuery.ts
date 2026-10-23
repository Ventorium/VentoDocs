import { useMemo } from 'react'
import { useLocation } from 'react-router'

export const useUrlQuery = <T extends Record<string, any> = Record<string, any>>() => {
  const location = useLocation()
  const { params, query } = useMemo(() => {
    const sq = new URLSearchParams(location.search)
    return {
      params: sq,
      query: Object.fromEntries(sq) as T
    }
  }, [location.search])
  return {
    query,
    params
  }
}
