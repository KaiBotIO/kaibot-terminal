// Bun text imports (`with { type: 'text' }`) for .sql assets.
declare module '*.sql' {
  const sql: string
  export default sql
}
