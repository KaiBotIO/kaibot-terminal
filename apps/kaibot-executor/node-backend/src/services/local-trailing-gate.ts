// SPINE: the executor never decides. Local autonomous stop-trailing moves the
// live protective stop with no server signal, so it must stay OFF unless the
// operator explicitly opts in via EXECUTOR_LOCAL_TRAILING. Default = disabled.
export function isLocalTrailingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.EXECUTOR_LOCAL_TRAILING
  return flag === '1' || flag === 'true'
}
