/**
 * Fail the build before CloudFormation's 500-resource ceiling does (issue 153).
 *
 * The Makerbay stack reached 496 of 500 before anyone was counting. This
 * reads every synthesized template in infra/cdk.out and enforces a budget,
 * so the ceiling can never again approach silently: the number is printed on
 * every CI run and the build fails while there is still room to act.
 *
 * Thresholds: warn at 480 (start planning), fail at 498 (two from the wall -
 * enough to land an emergency fix that itself costs a resource or two).
 * Run after `cdk synth`. No AWS access needed - it reads local output.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'infra', 'cdk.out')
const WARN_AT = 480
const FAIL_AT = 498
const LIMIT = 500

let failed = false
const templates = readdirSync(OUT).filter((f) => f.endsWith('.template.json')).sort()
if (templates.length === 0) {
  console.error(`No templates in ${OUT} - run cdk synth first.`)
  process.exit(2)
}

for (const file of templates) {
  const doc = JSON.parse(readFileSync(join(OUT, file), 'utf8'))
  const count = Object.keys(doc.Resources ?? {}).length
  const label = file.replace('.template.json', '')
  if (count >= FAIL_AT) {
    failed = true
    console.error(`FAIL  ${label}: ${count}/${LIMIT} resources - at the wall. See planning/stack-split-plan.md.`)
  } else if (count >= WARN_AT) {
    console.warn(`WARN  ${label}: ${count}/${LIMIT} resources - plan the split now, not at ${FAIL_AT}.`)
  } else {
    console.log(`ok    ${label}: ${count}/${LIMIT} resources`)
  }
}

process.exit(failed ? 1 : 0)
