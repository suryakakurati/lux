import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validatePlaybook } from '../shared/playbooks.ts'
import { EVAL_CASES, EVAL_TOOLS } from './cases.ts'
import { evaluateCases } from './check.ts'

const dir = join(process.cwd(), 'playbooks')
const playbooks = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    const validated = validatePlaybook(parsed)
    if (!validated.ok) throw new Error(`${file}: ${validated.error}`)
    return validated.playbook
  })

const results = evaluateCases(EVAL_TOOLS, playbooks)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id.padEnd(22)} ${result.plan}`)
  for (const reason of result.reasons) console.log(`     ${reason}`)
}

const failed = results.filter((result) => !result.ok).length
console.log(
  `\n[evals] ${results.length - failed}/${results.length} passed · ${playbooks.length} playbooks · ${EVAL_CASES.length} cases`
)
process.exitCode = failed > 0 ? 1 : 0
