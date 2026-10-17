import { useAtomValue } from 'jotai';
import { sessionRoleAtom } from '@/lib/atoms';
import { isDesktop } from '@/lib/utils';
import { HAS_VIEWER_ACCOUNTS } from '@/lib/edition';

// Desktop is the single local owner (no login), so it is always the admin.
// The public edition has no viewer accounts at all.
export function useIsViewer(): boolean {
  const role = useAtomValue(sessionRoleAtom);
  if (!HAS_VIEWER_ACCOUNTS || isDesktop()) return false;
  return role === 'viewer';
}
