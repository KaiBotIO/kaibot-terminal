import { useAtomValue } from 'jotai';
import { sessionRoleAtom } from '@/lib/atoms';
import { isDesktop } from '@/lib/utils';

// Desktop is the single local owner (no login), so it is always the admin.
export function useIsViewer(): boolean {
  const role = useAtomValue(sessionRoleAtom);
  if (isDesktop()) return false;
  return role === 'viewer';
}
