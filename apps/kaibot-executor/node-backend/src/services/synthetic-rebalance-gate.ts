// SPINE: the executor never decides. The synthetic rebalancer autonomously
// places real orders with no server signal, so it stays OFF unless the
// operator explicitly opts in via SYNTHETIC_REBALANCE_ENABLED — and each
// position must additionally opt in via its auto_rebalance flag.
export function isSyntheticRebalanceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.SYNTHETIC_REBALANCE_ENABLED
  return flag === '1' || flag === 'true'
}
