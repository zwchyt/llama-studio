export interface BashInput {
  command: string
  description?: string
  timeout?: number
  is_background?: boolean
  max_output_chars?: number
  auto_background?: boolean
}

export interface BashOutput {
  stdout: string
  stderr: string
  code: number
  truncated?: boolean
  totalBytes?: number
  outputFile?: string
  autoBackgrounded?: boolean
  taskId?: string
}
