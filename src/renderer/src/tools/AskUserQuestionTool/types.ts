export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

export interface Question {
  question: string
  options: QuestionOption[]
  multi_select?: boolean
}

export interface AskUserQuestionInput {
  questions: Question[]
}
