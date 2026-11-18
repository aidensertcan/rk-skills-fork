import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'repo-host', 'rk-host.mjs')
const results = { pass: 0, fail: 0, skip: 0 }

function rk(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [HOST, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  let error = null
  try { error = JSON.parse(r.stderr.trim().split('\n').pop()) } catch {}
  return { code: r.status, stdout: r.stdout, json, error }
}

function check(name, fn) {
  try {
    fn()
    results.pass++
    console.log(`PASS ${name}`)
  } catch (e) {
    results.fail++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}

function skip(name, reason) {
  results.skip++
  console.log(`SKIP ${name}: ${reason}`)
}

function expect(cond, message) {
  if (!cond) throw new Error(message)
}

function scratchRepo(remote) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-host-test-'))
  spawnSync('git', ['init', '-q', dir])
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  return dir
}

console.log('== offline: argument and remote handling')
check('unknown command exits 2 outside a repository', () => {
  const r = rk(tmpdir(), ['frobnicate'])
  expect(r.code === 2 && /unknown command/.test(r.error?.error), `code ${r.code}`)
})
check('unsupported remote fails', () => {
  const dir = scratchRepo('https://gitlab.com/a/b.git')
  try {
    const r = rk(dir, ['context'])
    expect(r.code === 1 && /unsupported git remote/.test(r.error?.error), `code ${r.code} ${r.error?.error}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
for (const [form, remote] of [
  ['https', 'https://dev.azure.com/org1/Proj%20One/_git/repo1'],
  ['https with user', 'https://user@dev.azure.com/org1/Proj%20One/_git/repo1'],
  ['ssh', 'git@ssh.dev.azure.com:v3/org1/Proj%20One/repo1'],
  ['visualstudio.com', 'https://org1.visualstudio.com/Proj%20One/_git/repo1'],
]) {
  check(`ADO remote parse: ${form}`, () => {
    const dir = scratchRepo(remote)
    try {
      const r = rk(dir, ['context'], { RK_HOST_ADO_TOKEN: 'invalid' })
      expect(r.code === 1 && r.error?.error.includes('https://dev.azure.com/org1/Proj%20One/_apis/git/repositories/repo1'), `code ${r.code} ${r.error?.error}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
check('issue create without --parent stops before any API call', () => {
  const dir = scratchRepo('https://dev.azure.com/org1/p/_git/r')
  const body = join(dir, 'body.md')
  writeFileSync(body, 'x')
  try {
    const r = rk(dir, ['issue', 'create', '--title', 't', '--body-file', body], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(r.code === 2 && /--parent is required/.test(r.error?.error), `code ${r.code} ${r.error?.error}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
check('pr merge rejects a short SHA', () => {
  const dir = scratchRepo('https://dev.azure.com/org1/p/_git/r')
  try {
    const r = rk(dir, ['pr', 'merge', '1', '--match-head', 'abc'], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(r.code === 2 && /40-character/.test(r.error?.error), `code ${r.code}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const ado = process.env.RK_TEST_ADO_CHECKOUT
console.log('== Azure DevOps read suite (real organization, read-only)')
if (!ado) skip('ADO read suite', 'set RK_TEST_ADO_CHECKOUT, RK_TEST_ADO_PR, RK_TEST_ADO_ISSUE, RK_TEST_ADO_BOT_ID')
else {
  const pr = process.env.RK_TEST_ADO_PR
  const issue = process.env.RK_TEST_ADO_ISSUE
  const bot = (process.env.RK_TEST_ADO_BOT_ID ?? '').toLowerCase()
  check('invalid token is an authentication error, never Anonymous', () => {
    const r = rk(ado, ['whoami'], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(r.code === 1 && /anonymous|rejected the credentials/.test(r.error?.error), `code ${r.code} ${r.stdout}`)
  })
  check('context resolves the ADO repository', () => {
    const r = rk(ado, ['context'])
    expect(r.code === 0 && r.json.host === 'ado' && r.json.defaultBranch, `code ${r.code}`)
  })
  check('whoami returns a real identity', () => {
    const r = rk(ado, ['whoami'])
    expect(r.code === 0 && r.json.id && r.json.name !== 'Anonymous', `code ${r.code}`)
  })
  check('pr view normalizes state, refs, and linked work items', () => {
    const r = rk(ado, ['pr', 'view', pr])
    expect(r.code === 0 && ['OPEN', 'MERGED', 'CLOSED'].includes(r.json.state) && /^[0-9a-f]{40}$/.test(r.json.headRefOid) && !r.json.headRefName.startsWith('refs/'), JSON.stringify(r.json ?? r.error))
    expect(r.json.closingIssues.includes(Number(issue)), `closingIssues ${r.json.closingIssues}`)
  })
  check('pr threads classify the configured bot as trusted', () => {
    const r = rk(ado, ['pr', 'threads', pr])
    expect(r.code === 0 && r.json.length > 0, `code ${r.code}`)
    const botComments = r.json.flatMap((t) => t.comments).filter((c) => String(c.author.id).toLowerCase() === bot)
    expect(botComments.length > 0 && botComments.every((c) => c.trusted && c.association === 'BOT'), 'bot comments missing or untrusted')
    expect(r.json.every((t) => t.path && typeof t.isResolved === 'boolean'), 'thread shape')
  })
  check('pr reviews mark the invoking user as SELF', () => {
    const me = rk(ado, ['whoami']).json
    const r = rk(ado, ['pr', 'reviews', pr])
    const mine = r.json.find((v) => v.author.id === me.id)
    expect(!mine || (mine.trusted && mine.association === 'SELF'), 'self review not trusted')
  })
  check('pr checks map policy evaluations', () => {
    const r = rk(ado, ['pr', 'checks', pr])
    expect(r.code === 0 && r.json.length > 0 && r.json.every((c) => ['SUCCESS', 'FAILURE', 'PENDING', 'SKIPPED'].includes(c.state)), `code ${r.code}`)
  })
  check('pr diff returns a unified diff', () => {
    const r = rk(ado, ['pr', 'diff', pr])
    expect(r.code === 0 && /^diff --git /m.test(r.stdout), `code ${r.code}`)
  })
  check('pr list finds the PR by head branch', () => {
    const head = rk(ado, ['pr', 'view', pr]).json.headRefName
    const r = rk(ado, ['pr', 'list', '--state', 'all', '--head', head])
    expect(r.code === 0 && r.json.some((p) => String(p.number) === String(pr)), `code ${r.code}`)
  })
  check('issue view returns a normalized work item with comments', () => {
    const r = rk(ado, ['issue', 'view', issue, '--comments'])
    expect(r.code === 0 && r.json.number === Number(issue) && ['OPEN', 'CLOSED'].includes(r.json.state) && r.json.rawState && Array.isArray(r.json.comments), JSON.stringify(r.error))
  })
  check('issue linked-prs finds the linked PR', () => {
    const r = rk(ado, ['issue', 'linked-prs', issue])
    expect(r.code === 0 && r.json.some((p) => String(p.number) === String(pr)), `code ${r.code}`)
  })
  check('issue list filters by state in the query', () => {
    for (const state of ['open', 'closed']) {
      const r = rk(ado, ['issue', 'list', '--state', state, '--limit', '5'])
      expect(r.code === 0 && r.json.every((i) => i.state === state.toUpperCase()), `${state}: ${JSON.stringify(r.json?.map((i) => i.state))}`)
    }
  })
}

const gh = process.env.RK_TEST_GITHUB_CHECKOUT
console.log('== GitHub read suite (real repository, read-only)')
if (!gh) skip('GitHub read suite', 'set RK_TEST_GITHUB_CHECKOUT, RK_TEST_GITHUB_PR, RK_TEST_GITHUB_ISSUE (needs gh auth login)')
else {
  const pr = process.env.RK_TEST_GITHUB_PR
  const issue = process.env.RK_TEST_GITHUB_ISSUE
  check('context resolves the GitHub repository', () => {
    const r = rk(gh, ['context'])
    expect(r.code === 0 && r.json.host === 'github' && r.json.defaultBranch, JSON.stringify(r.error))
  })
  check('pr view normalizes state and refs', () => {
    const r = rk(gh, ['pr', 'view', pr])
    expect(r.code === 0 && ['OPEN', 'MERGED', 'CLOSED'].includes(r.json.state) && /^[0-9a-f]{40}$/.test(r.json.headRefOid), JSON.stringify(r.error))
  })
  check('pr threads and comments carry trust fields', () => {
    for (const verb of ['threads', 'comments']) {
      const r = rk(gh, ['pr', verb, pr])
      expect(r.code === 0 && Array.isArray(r.json), `${verb}: ${JSON.stringify(r.error)}`)
      const items = verb === 'threads' ? r.json.flatMap((t) => t.comments) : r.json
      expect(items.every((c) => typeof c.trusted === 'boolean' && c.association), `${verb} trust fields`)
    }
  })
  check('pr checks returns normalized states', () => {
    const r = rk(gh, ['pr', 'checks', pr])
    expect(r.code === 0 && r.json.every((c) => ['SUCCESS', 'FAILURE', 'PENDING', 'SKIPPED'].includes(c.state)), JSON.stringify(r.error))
  })
  check('issue view returns comments with trust fields', () => {
    const r = rk(gh, ['issue', 'view', issue, '--comments'])
    expect(r.code === 0 && r.json.comments.every((c) => typeof c.trusted === 'boolean'), JSON.stringify(r.error))
  })
  check('pr link is an explicit unsupported error on GitHub', () => {
    expect(rk(gh, ['pr', 'link', pr, '--issue', issue]).code === 3, 'pr link')
  })
}

console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`)
process.exit(results.fail ? 1 : 0)
