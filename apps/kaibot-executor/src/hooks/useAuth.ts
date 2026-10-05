import { useEffect } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { useLocation } from 'react-router-dom'
import { userAtom, userGroupsAtom } from '../lib/atoms'
import { api } from '../lib/api'

export function useAuth() {
  const [user, setUser] = useAtom(userAtom)
  const setUserGroups = useSetAtom(userGroupsAtom)
  const location = useLocation()

  useEffect(() => {
    // Don't fetch user data on setup page
    if (location.pathname === '/setup') {
      return
    }

    // Fetch user data on mount
    const fetchUser = async () => {
      let nextUser: { name: string; email: string } | null = null
      let nextGroups: string[] = []
      try {
        // The session endpoint names the signed-in account (admin or
        // viewer); /api/auth/me only ever describes the admin.
        const userData = await api.get('/api/auth/session')
        nextUser = {
          name: userData.username || 'User',
          email: `${userData.username}@kaibot-executor.local`,
        }
        nextGroups = Array.isArray(userData.groups) ? userData.groups : []
      } catch (error: any) {
        console.error('Failed to fetch user data:', error)
        // Only set fallback if we're not in setup flow
        if (!error.message?.includes('404')) {
          nextUser = {
            name: 'Executor User',
            email: 'user@kaibot-executor.local',
          }
        }
      }
      setUserGroups(nextGroups)
      if (nextUser) setUser(nextUser)
    }

    if (!user) {
      fetchUser()
    }
  }, [user, setUser, setUserGroups, location.pathname])

  return { user }
}