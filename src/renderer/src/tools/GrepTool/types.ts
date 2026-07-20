export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  head_limit?: number
  '-i'?: boolean
  context?: number
  '-n'?: boolean
  type?: string
  timeout_seconds?: number
}
