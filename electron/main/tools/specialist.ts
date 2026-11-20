import type { ToolDef } from './types'

export const specialistTools: ToolDef[] = [
  {
    name: 'consult_specialist',
    description:
      'Consult the separately configured specialist model for one bounded, difficult reasoning problem when the primary model is genuinely stuck. It is not a second agent and has no tools. Loading it costs memory, so use it only when the benefit justifies that cost.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The exact reasoning problem, with the relevant evidence included.' }
      },
      required: ['question']
    },
    timeoutMs: 130_000,
    async run(args, context) {
      if (!context.models) {
        return { content: 'No specialist is available in this context.', summary: 'no specialist' }
      }
      const question = String(args.question ?? '').trim()
      if (question.length < 10) return { content: 'State the problem for the specialist.', summary: 'empty question' }
      try {
        const result = await context.models.consult(question)
        return {
          content: `Specialist ${result.model} (${Math.round(result.ms / 1000)}s):\n\n${result.text}`,
          summary: `specialist ${result.model}`,
          openChat: true
        }
      } catch (error) {
        return {
          content: `The specialist was not used: ${error instanceof Error ? error.message : String(error)}`,
          summary: 'specialist unavailable'
        }
      }
    }
  }
]
