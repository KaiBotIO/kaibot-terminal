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
        // For now, we'll use a simple endpoint to get user info
        // In a real app, this would include proper token management
        const userData = await api.get('/api/auth/me')
        nextUser = {
          name: userData.username || userData.name || 'User',
          email: userData.email || `${userData.username}@kaibot.local`,
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