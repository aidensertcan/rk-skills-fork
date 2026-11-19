import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'repo-host', 'rk-host.mjs')
const results = { pass: 0, fail: 0, skip: 0 }
const TS = String(Date.now())
const scratch = mkdtempSync(join(tmpdir(), 'rk-host-bodies-'))

function rk(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [HOST, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  let error = null
  try { error = JSON.parse(r.stderr.trim().split('\n').pop()) } catch {}
  return { code: r.status, stdout: r.stdout, json, error }
}

function ok(cwd, args, env) {
  const r = rk(cwd, args, env)
  if (r.code !== 0) throw new Error(`rk-host ${args.slice(0, 2).join(' ')} exited ${r.code}: ${r.error?.error ?? r.stdout}`)
  return r.json ?? r.stdout
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function body(name, text) {
  const f = join(scratch, name)
  writeFileSync(f, text)
  return f
}

async function check(name, fn) {
  try {
    await fn()
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

function adoToken() {
  const args = ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv']
  const r = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `az ${args.join(' ')}`], { encoding: 'utf8' })
    : spawnSync('az', args, { encoding: 'utf8' })
  return r.stdout.trim()
}

async function adoRest(method, url, payload) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${adoToken()}`, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) })
  if (!res.ok) throw new Error(`${method} ${url} returned ${res.status}: ${await res.text()}`)
  return res.json()
}

function pushBranch(repo, branch, from, file) {
  sh('git', ['-C', repo, 'fetch', '-q', 'origin'], repo)
  sh('git', ['-C', repo, 'switch', '-q', '-C', branch, from], repo)
  if (file) {
    writeFileSync(join(repo, file), `rk-host integration test ${TS}\n`)
    sh('git', ['-C', repo, 'add', file], repo)
    sh('git', ['-C', repo, '-c', 'user.name=rk-host-test', '-c', 'user.email=rk-host-test@example.invalid', 'commit', '-q', '-m', `test: rk-host ${TS}`], repo)
  }
  sh('git', ['-C', repo, 'push', '-q', '-u', 'origin', branch], repo)
  return sh('git', ['-C', repo, 'rev-parse', 'HEAD'], repo)
}

function deleteRemoteBranch(repo, branch) {
  spawnSync('git', ['-C', repo, 'push', '-q', 'origin', '--delete', branch], { encoding: 'utf8' })
}

console.log('== offline: argument and remote handling')
await check('unknown command exits 2 outside a repository', () => {
  const r = rk(tmpdir(), ['frobnicate'])
  expect(r.code === 2 && /unknown command/.test(r.error?.error), `code ${r.code}`)
})
await check('unsupported remote fails', () => {
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
  await check(`ADO remote parse: ${form}`, () => {
    const dir = scratchRepo(remote)
    try {
      const r = rk(dir, ['context'], { RK_HOST_ADO_TOKEN: 'invalid' })
      expect(r.code === 1 && r.error?.error.includes('https://dev.azure.com/org1/Proj%20One/_apis/git/repositories/repo1'), `code ${r.code} ${r.error?.error}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
await check('issue create without --parent stops before any API call', () => {
  const dir = scratchRepo('https://dev.azure.com/org1/p/_git/r')
  try {
    const r = rk(dir, ['issue', 'create', '--title', 't', '--body-file', body('p.md', 'x')], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(r.code === 2 && /--parent is required/.test(r.error?.error), `code ${r.code} ${r.error?.error}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('--flag=value is parsed and an unknown flag is a usage error', () => {
  const dir = scratchRepo('https://dev.azure.com/org1/p/_git/r')
  try {
    const bad = rk(dir, ['pr', 'list', '--state=bogus'], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(bad.code === 2 && /--state must be one of/.test(bad.error?.error), `state=: code ${bad.code} ${bad.error?.error}`)
    const unknown = rk(dir, ['issue', 'close', '1', '--reasn', 'not_planned'], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(unknown.code === 2 && /does not accept --reasn/.test(unknown.error?.error), `unknown: code ${unknown.code} ${unknown.error?.error}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('config comes from origin/HEAD, never the working tree', () => {
  const dir = scratchRepo('https://dev.azure.com/org1/p/_git/r')
  const env = { RK_HOST_ADO_TOKEN: 'invalid', RK_SKILLS_HOME: join(dir, '.no-user-config') }
  const args = ['issue', 'create', '--title', 't', '--body-file', body('cfg.md', 'x')]
  try {
    writeFileSync(join(dir, '.rk-skills.json'), JSON.stringify({ requireParent: false }))
    const tree = rk(dir, args, env)
    expect(tree.code === 2 && /--parent is required/.test(tree.error?.error), `working tree config was read: code ${tree.code} ${tree.error?.error}`)
    sh('git', ['-C', dir, 'add', '.rk-skills.json'], dir)
    sh('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'cfg'], dir)
    sh('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], dir)
    sh('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], dir)
    const head = rk(dir, args, env)
    expect(head.code === 1 && /rejected the credentials|anonymous/.test(head.error?.error), `origin/HEAD config not honored: code ${head.code} ${head.error?.error}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('pr merge rejects a short SHA', () => {
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
  await check('invalid token is an authentication error, never Anonymous', () => {
    const r = rk(ado, ['whoami'], { RK_HOST_ADO_TOKEN: 'invalid' })
    expect(r.code === 1 && /anonymous|rejected the credentials/.test(r.error?.error), `code ${r.code} ${r.stdout}`)
  })
  await check('context resolves the ADO repository', () => {
    const r = ok(ado, ['context'])
    expect(r.host === 'ado' && r.defaultBranch, 'context')
  })
  await check('whoami returns a real identity', () => {
    const r = ok(ado, ['whoami'])
    expect(r.id && r.name !== 'Anonymous', 'identity')
  })
  await check('pr view normalizes state, refs, and linked work items', () => {
    const r = ok(ado, ['pr', 'view', pr])
    expect(['OPEN', 'MERGED', 'CLOSED'].includes(r.state) && /^[0-9a-f]{40}$/.test(r.headRefOid) && !r.headRefName.startsWith('refs/'), JSON.stringify(r))
    expect(r.closingIssues.includes(Number(issue)), `closingIssues ${r.closingIssues}`)
  })
  await check('pr threads classify the configured bot as trusted', () => {
    const r = ok(ado, ['pr', 'threads', pr])
    const botComments = r.flatMap((t) => t.comments).filter((c) => String(c.author.id).toLowerCase() === bot)
    expect(botComments.length > 0 && botComments.every((c) => c.trusted && c.association === 'BOT'), 'bot comments missing or untrusted')
    expect(r.every((t) => t.path && typeof t.isResolved === 'boolean'), 'thread shape')
  })
  await check('pr reviews mark the invoking user as SELF', () => {
    const me = ok(ado, ['whoami'])
    const mine = ok(ado, ['pr', 'reviews', pr]).find((v) => v.author.id === me.id)
    expect(!mine || (mine.trusted && mine.association === 'SELF'), 'self review not trusted')
  })
  await check('pr checks map policy evaluations', () => {
    const r = ok(ado, ['pr', 'checks', pr])
    expect(r.length > 0 && r.every((c) => ['SUCCESS', 'FAILURE', 'PENDING', 'SKIPPED'].includes(c.state)), 'states')
  })
  await check('pr diff returns a unified diff', () => {
    expect(/^diff --git /m.test(ok(ado, ['pr', 'diff', pr])), 'diff')
  })
  await check('pr list finds the PR by head branch', () => {
    const head = ok(ado, ['pr', 'view', pr]).headRefName
    expect(ok(ado, ['pr', 'list', '--state', 'all', '--head', head]).some((p) => String(p.number) === String(pr)), 'not found')
  })
  await check('issue view returns a normalized work item with comments', () => {
    const r = ok(ado, ['issue', 'view', issue, '--comments'])
    expect(r.number === Number(issue) && ['OPEN', 'CLOSED'].includes(r.state) && r.rawState && Array.isArray(r.comments), 'shape')
  })
  await check('issue linked-prs finds the linked PR', () => {
    expect(ok(ado, ['issue', 'linked-prs', issue]).some((p) => String(p.number) === String(pr)), 'not linked')
  })
  await check('issue list filters by state in the query', () => {
    for (const state of ['open', 'closed']) {
      const r = ok(ado, ['issue', 'list', '--state', state, '--limit', '5'])
      expect(r.every((i) => i.state === state.toUpperCase()), `${state}: ${JSON.stringify(r.map((i) => i.state))}`)
    }
  })
}

console.log('== Azure DevOps write suite (work items and PRs, cleaned up after)')
const adoBoards = process.env.RK_TEST_ADO_WRITE === '1' ? ado : null
const adoSandbox = process.env.RK_TEST_ADO_PR_SANDBOX
if (!adoBoards || !adoSandbox) skip('ADO write suite', 'set RK_TEST_ADO_WRITE=1, RK_TEST_ADO_CHECKOUT (boards), and RK_TEST_ADO_PR_SANDBOX (a clone of a sandbox repository)')
else {
  const made = { story: null, task: null, pr: null, base: `rk-host-test/base-${TS}`, head: `rk-host-test/head-${TS}`, file: `rk-host-test-${TS}.md` }
  try {
    await check('ADO: create a parent User Story in the boards project', () => {
      const r = ok(adoBoards, ['issue', 'create', '--type', 'User Story', '--title', `[rk-host test ${TS}] parent, safe to remove`, '--body-file', body('s.md', `Integration test parent.\n\n- created by rk-host ${TS}`)])
      made.story = r.number
      const ctx = ok(adoBoards, ['context'])
      expect(r.url.includes(encodeURIComponent(ctx.boardsProject)), `url ${r.url} not in ${ctx.boardsProject}`)
    })
    await check('ADO: create a Task under the Story with Markdown and a tag', () => {
      const r = ok(adoBoards, ['issue', 'create', '--title', `[rk-host test ${TS}] task`, '--body-file', body('t.md', `## Problem\n\nTest **markdown** ${TS}.`), '--label', 'rk-host-test', '--parent', String(made.story)])
      made.task = r.number
      const v = ok(adoBoards, ['issue', 'view', String(made.task)])
      expect(v.parent === made.story && v.bodyFormat === 'markdown' && v.body.includes('**markdown**') && v.labels.includes('rk-host-test') && v.state === 'OPEN' && v.type === 'Task', JSON.stringify(v))
    })
    await check('ADO: a Task parent that is not a User Story is refused', () => {
      const r = rk(adoBoards, ['issue', 'create', '--title', `[rk-host test ${TS}] must not exist`, '--body-file', body('x.md', 'x'), '--parent', String(made.task)])
      expect(r.code === 2 && /not a User Story/.test(r.error?.error), `code ${r.code} ${r.error?.error}`)
      expect(ok(adoBoards, ['issue', 'list', '--state', 'all', '--search', `${TS}] must not exist`]).length === 0, 'refused item exists')
    })
    await check('ADO: edit title and tags with a revision check', () => {
      ok(adoBoards, ['issue', 'edit', String(made.task), '--title', `[rk-host test ${TS}] task edited`, '--add-label', 'rk-host-edited', '--remove-label', 'rk-host-test'])
      const v = ok(adoBoards, ['issue', 'view', String(made.task)])
      expect(v.title.endsWith('task edited') && v.labels.includes('rk-host-edited') && !v.labels.includes('rk-host-test'), JSON.stringify(v.labels))
    })
    await check('ADO: Markdown comment, read back as SELF and trusted', () => {
      ok(adoBoards, ['issue', 'comment', String(made.task), '--body-file', body('c.md', `Comment **${TS}**`)])
      const c = ok(adoBoards, ['issue', 'view', String(made.task), '--comments']).comments.find((x) => x.body.includes(TS))
      expect(c && c.bodyFormat === 'markdown' && c.association === 'SELF' && c.trusted, JSON.stringify(c))
    })
    await check('ADO: list finds the Task in the configured area', () => {
      expect(ok(adoBoards, ['issue', 'list', '--state', 'open', '--search', TS]).some((i) => i.number === made.task), 'task not listed')
    })
    await check('ADO: work item writes drop attribution footers and model tags', () => {
      const attributed = [
        `**Complexity: 62/100** — Capability 2 (Risk 3, Uncertainty 2 — persisted write); Volume 12 (Scope 2, Coupling 2, Verification 2) — Opus 5.5, high · plan: no`,
        '', '## Problem', '', `Attribution test ${TS}. A plain --- rule stays:`, '', '---', '', 'End of body.',
        '', '---', 'Created with LLM: Opus 5.5 | high | Harness: Copilot CLI', 'Validated with LLM: Fable 5.2 | high | Harness: Copilot CLI | fable-validate',
      ].join('\n')
      const clean = [
        `**Complexity: 62/100** — Capability 2 (Risk 3, Uncertainty 2 — persisted write); Volume 12 (Scope 2, Coupling 2, Verification 2) · plan: no`,
        '', '## Problem', '', `Attribution test ${TS}. A plain --- rule stays:`, '', '---', '', 'End of body.',
      ].join('\n')
      ok(adoBoards, ['issue', 'edit', String(made.task), '--body-file', body('attr.md', attributed)])
      const v = ok(adoBoards, ['issue', 'view', String(made.task)]).body
      expect(v === clean, `body:\n${v}`)
      ok(adoBoards, ['issue', 'comment', String(made.task), '--body-file', body('attr-c.md', `## Implementation plan (Fable 5.2)\n\nPlan ${TS}\n\n---\nCreated with LLM: Fable 5.2 | high | Harness: Copilot CLI | fableplan`)])
      const c = ok(adoBoards, ['issue', 'view', String(made.task), '--comments']).comments.at(-1).body
      expect(c === `## Implementation plan\n\nPlan ${TS}`, `comment:\n${c}`)
    })
    await check('ADO: Markdown with HTML-sensitive text round-trips exactly, comments oldest first', () => {
      const tricky = `A & B < C > D "E" 'F' literal-&amp; &quot; <b>x</b>\n\n> quote\n\n\`List<String> & <x> "q"\` ${TS}`
      ok(adoBoards, ['issue', 'edit', String(made.task), '--body-file', body('esc.md', tricky)])
      expect(ok(adoBoards, ['issue', 'view', String(made.task)]).body === tricky, 'body changed in storage')
      ok(adoBoards, ['issue', 'comment', String(made.task), '--body-file', body('esc2.md', tricky)])
      const comments = ok(adoBoards, ['issue', 'view', String(made.task), '--comments']).comments
      expect(comments.at(-1).body === tricky, 'newest comment is not last or changed in storage')
      expect(comments.every((c, i) => i === 0 || new Date(comments[i - 1].createdAt) <= new Date(c.createdAt)), 'comments not oldest first')
    })

    await check('ADO: open a PR linked to the Task across projects', () => {
      pushBranch(adoSandbox, made.base, 'origin/main')
      made.sha = pushBranch(adoSandbox, made.head, made.base, made.file)
      const r = ok(adoSandbox, ['pr', 'create', '--title', `test: rk-host ${TS}`, '--body-file', body('pr.md', `Integration test PR ${TS}.`), '--base', made.base, '--head', made.head, '--issue', String(made.task)])
      made.pr = r.number
      const v = ok(adoSandbox, ['pr', 'view', String(made.pr)])
      expect(v.state === 'OPEN' && v.headRefOid === made.sha && v.headRefName === made.head && v.baseRefName === made.base && v.closingIssues.includes(made.task), JSON.stringify(v))
    })
    await check('ADO: a description over 4000 characters is refused', () => {
      const r = rk(adoSandbox, ['pr', 'edit', String(made.pr), '--body-file', body('long.md', 'x'.repeat(4001))])
      expect(r.code === 3 && /4000/.test(r.error?.error), `code ${r.code}`)
    })
    await check('ADO: pr list finds the PR by head', () => {
      expect(ok(adoSandbox, ['pr', 'list', '--head', made.head]).some((p) => p.number === made.pr), 'not listed')
    })
    await check('ADO: PR comment reads back as SELF', () => {
      ok(adoSandbox, ['pr', 'comment', String(made.pr), '--body-file', body('pc.md', `PR comment ${TS}`)])
      const c = ok(adoSandbox, ['pr', 'comments', String(made.pr)]).find((x) => x.body.includes(`PR comment ${TS}`))
      expect(c && c.association === 'SELF' && c.trusted, JSON.stringify(c))
    })
    await check('ADO: inline thread list, reply, and resolve', async () => {
      const ctx = ok(adoSandbox, ['context'])
      const url = `https://dev.azure.com/${ctx.org}/${encodeURIComponent(ctx.project)}/_apis/git/repositories/${encodeURIComponent(ctx.repo)}/pullRequests/${made.pr}/threads?api-version=7.1`
      const seeded = await adoRest('POST', url, { comments: [{ parentCommentId: 0, content: `seed ${TS}`, commentType: 1 }], status: 'active', threadContext: { filePath: `/${made.file}`, rightFileStart: { line: 1, offset: 1 }, rightFileEnd: { line: 1, offset: 2 } } })
      let t = ok(adoSandbox, ['pr', 'threads', String(made.pr)]).find((x) => x.id === String(seeded.id))
      expect(t && t.path === made.file && t.line === 1 && !t.isResolved && t.comments[0].trusted, JSON.stringify(t))
      ok(adoSandbox, ['pr', 'reply', String(made.pr), '--thread', t.id, '--body-file', body('r.md', `reply ${TS}`)])
      ok(adoSandbox, ['pr', 'resolve', String(made.pr), '--thread', t.id])
      t = ok(adoSandbox, ['pr', 'threads', String(made.pr)]).find((x) => x.id === String(seeded.id))
      expect(t.isResolved && t.comments.length === 2 && t.comments[1].body.includes(`reply ${TS}`), JSON.stringify(t))
    })
    await check('ADO: review votes read back', () => {
      ok(adoSandbox, ['pr', 'review', String(made.pr), '--event', 'request-changes', '--body-file', body('rv.md', `Needs Updates ${TS}`)])
      const me = ok(adoSandbox, ['whoami'])
      expect(ok(adoSandbox, ['pr', 'reviews', String(made.pr)]).find((v) => v.author.id === me.id)?.state === 'CHANGES_REQUESTED', 'vote not -5')
      ok(adoSandbox, ['pr', 'review', String(made.pr), '--event', 'approve'])
      expect(ok(adoSandbox, ['pr', 'reviews', String(made.pr)]).find((v) => v.author.id === me.id)?.state === 'APPROVED', 'vote not 10')
    })
    await check('ADO: checks and diff', () => {
      expect(Array.isArray(ok(adoSandbox, ['pr', 'checks', String(made.pr)])), 'checks')
      expect(ok(adoSandbox, ['pr', 'diff', String(made.pr)]).includes(made.file), 'diff missing file')
    })
    await check('ADO: merge refuses a stale head', () => {
      const r = rk(adoSandbox, ['pr', 'merge', String(made.pr), '--squash', '--match-head', '0'.repeat(40)])
      expect(r.code === 1 && /refusing to merge/.test(r.error?.error), `code ${r.code}`)
      expect(ok(adoSandbox, ['pr', 'view', String(made.pr)]).state === 'OPEN', 'PR changed')
    })
    await check('ADO: link the PR to a second Task, idempotent, and read the link back', () => {
      made.task2 = ok(adoBoards, ['issue', 'create', '--title', `[rk-host test ${TS}] second task`, '--body-file', body('t2.md', 'second'), '--parent', String(made.story)]).number
      expect(ok(adoSandbox, ['pr', 'link', String(made.pr), '--issue', String(made.task2)]).existing === false, 'first link')
      expect(ok(adoSandbox, ['pr', 'link', String(made.pr), '--issue', String(made.task2)]).existing === true, 'second link')
      expect(ok(adoBoards, ['issue', 'linked-prs', String(made.task2)]).some((p) => p.number === made.pr), 'linked-prs')
    })
    await check('ADO: squash merge at the pinned head deletes the source branch', async () => {
      const r = ok(adoSandbox, ['pr', 'merge', String(made.pr), '--squash', '--match-head', made.sha, '--delete-branch'])
      expect(r.merged, 'merged')
      let v
      for (let i = 0; i < 10; i++) {
        v = ok(adoSandbox, ['pr', 'view', String(made.pr)])
        if (v.state === 'MERGED') break
        await new Promise((res) => setTimeout(res, 2000))
      }
      expect(v.state === 'MERGED', `state ${v.state}`)
    })
    await check('ADO: merge transitioned the linked Tasks and left the Story open', () => {
      for (const id of [made.task, made.task2]) {
        const v = ok(adoBoards, ['issue', 'view', String(id)])
        expect(v.state === 'CLOSED' || v.rawState === 'Resolved', `${id}: ${v.state}/${v.rawState}`)
      }
      expect(ok(adoBoards, ['issue', 'view', String(made.story)]).state === 'OPEN', 'story was closed')
    })
    await check('ADO: close as completed, and closed list finds it', () => {
      ok(adoBoards, ['issue', 'close', String(made.task)])
      const v = ok(adoBoards, ['issue', 'view', String(made.task)])
      expect(v.state === 'CLOSED', `${v.state}/${v.rawState}`)
      expect(ok(adoBoards, ['issue', 'list', '--state', 'closed', '--search', TS]).some((i) => i.number === made.task), 'not in closed list')
    })
  } finally {
    deleteRemoteBranch(adoSandbox, made.head)
    deleteRemoteBranch(adoSandbox, made.base)
    spawnSync('git', ['-C', adoSandbox, 'switch', '-q', '--detach', 'origin/main'])
    const final = []
    for (const id of [made.task, made.task2, made.story]) {
      if (!id) continue
      if (ok(adoBoards, ['issue', 'view', String(id)]).state === 'OPEN') rk(adoBoards, ['issue', 'close', String(id), '--reason', 'not_planned'])
      final.push(`${id}=${ok(adoBoards, ['issue', 'view', String(id)]).rawState}`)
    }
    console.log(`cleanup: work items ${final.join(', ') || '-'}; deleted branches ${made.head} and ${made.base}`)
  }
}

const gh = process.env.RK_TEST_GITHUB_SANDBOX
console.log('== GitHub write and read suite (scratch repository, cleaned up after)')
if (!gh) skip('GitHub suite', 'set RK_TEST_GITHUB_SANDBOX to a clone of a scratch repository (needs gh auth login)')
else {
  const made = { issue: null, pr: null, head: `rk-host-test/head-${TS}`, file: `rk-host-test-${TS}.md` }
  try {
    await check('GitHub: context and whoami', () => {
      const c = ok(gh, ['context'])
      expect(c.host === 'github' && c.defaultBranch, 'context')
      expect(ok(gh, ['whoami']).login, 'whoami')
    })
    await check('GitHub: --parent is an explicit unsupported error', () => {
      expect(rk(gh, ['issue', 'create', '--title', 'x', '--body-file', body('gp.md', 'x'), '--parent', '1']).code === 3, 'code')
    })
    await check('GitHub: issue create, edit, comment, and read back', () => {
      sh('gh', ['label', 'create', 'rk-host-test', '--force', '-R', ok(gh, ['context']).nameWithOwner], gh)
      made.issue = ok(gh, ['issue', 'create', '--title', `rk-host test ${TS}`, '--body-file', body('gi.md', `body ${TS}`), '--label', 'rk-host-test']).number
      ok(gh, ['issue', 'edit', String(made.issue), '--title', `rk-host test ${TS} edited`])
      ok(gh, ['issue', 'comment', String(made.issue), '--body-file', body('gc.md', `comment ${TS}`)])
      const v = ok(gh, ['issue', 'view', String(made.issue), '--comments'])
      const c = v.comments.find((x) => x.body.includes(`comment ${TS}`))
      expect(v.title.endsWith('edited') && v.labels.includes('rk-host-test') && c?.trusted && v.state === 'OPEN', JSON.stringify(v))
      expect(ok(gh, ['issue', 'list', '--label', 'rk-host-test']).some((i) => i.number === made.issue), 'list')
    })
    await check('GitHub: PR create, view, list, and comment', async () => {
      made.sha = pushBranch(gh, made.head, `origin/${ok(gh, ['context']).defaultBranch}`, made.file)
      const base = ok(gh, ['context']).defaultBranch
      made.pr = ok(gh, ['pr', 'create', '--title', `test: rk-host ${TS}`, '--body-file', body('gpr.md', `Closes #${made.issue}`), '--base', base, '--head', made.head]).number
      let v
      for (let i = 0; i < 15; i++) {
        v = ok(gh, ['pr', 'view', String(made.pr)])
        if (v.closingIssues.length) break
        await new Promise((res) => setTimeout(res, 2000))
      }
      expect(v.state === 'OPEN' && v.headRefOid === made.sha && v.closingIssues.includes(made.issue), JSON.stringify(v))
      expect(ok(gh, ['pr', 'list', '--head', made.head]).some((p) => p.number === made.pr), 'list')
      ok(gh, ['pr', 'comment', String(made.pr), '--body-file', body('gpc.md', `PR comment ${TS}`)])
      expect(ok(gh, ['pr', 'comments', String(made.pr)]).find((x) => x.body.includes(`PR comment ${TS}`))?.trusted, 'comment trust')
    })
    await check('GitHub: --issue and pr link are explicit unsupported errors', () => {
      expect(rk(gh, ['pr', 'link', String(made.pr), '--issue', String(made.issue)]).code === 3, 'pr link')
    })
    await check('GitHub: inline thread list, reply, and resolve', () => {
      const nwo = ok(gh, ['context']).nameWithOwner
      sh('gh', ['api', '-X', 'POST', `repos/${nwo}/pulls/${made.pr}/comments`, '-f', `body=seed ${TS}`, '-f', `commit_id=${made.sha}`, '-f', `path=${made.file}`, '-F', 'line=1', '-f', 'side=RIGHT'], gh)
      let t = ok(gh, ['pr', 'threads', String(made.pr)]).find((x) => x.comments[0].body.includes(`seed ${TS}`))
      expect(t && t.path === made.file && !t.isResolved && t.comments[0].trusted, JSON.stringify(t))
      ok(gh, ['pr', 'reply', String(made.pr), '--thread', t.id, '--body-file', body('gr.md', `reply ${TS}`)])
      ok(gh, ['pr', 'resolve', String(made.pr), '--thread', t.id])
      t = ok(gh, ['pr', 'threads', String(made.pr)]).find((x) => x.id === t.id)
      expect(t.isResolved && t.comments.length === 2, JSON.stringify(t))
    })
    await check('GitHub: comment review, reviews, checks, and diff', () => {
      ok(gh, ['pr', 'review', String(made.pr), '--event', 'comment', '--body-file', body('grv.md', `review ${TS}`)])
      expect(ok(gh, ['pr', 'reviews', String(made.pr)]).some((r) => r.body.includes(`review ${TS}`) && r.trusted), 'review')
      expect(Array.isArray(ok(gh, ['pr', 'checks', String(made.pr)])), 'checks')
      expect(ok(gh, ['pr', 'diff', String(made.pr)]).includes(made.file), 'diff')
    })
    await check('GitHub: merge refuses a stale head, then merges at the pinned head', () => {
      const bad = rk(gh, ['pr', 'merge', String(made.pr), '--squash', '--match-head', '0'.repeat(40)])
      expect(bad.code === 1 && ok(gh, ['pr', 'view', String(made.pr)]).state === 'OPEN', `stale merge code ${bad.code}`)
      ok(gh, ['pr', 'merge', String(made.pr), '--squash', '--match-head', made.sha, '--delete-branch'])
      expect(ok(gh, ['pr', 'view', String(made.pr)]).state === 'MERGED', 'not merged')
      expect(ok(gh, ['issue', 'linked-prs', String(made.issue)]).some((p) => p.number === made.pr), 'linked-prs')
    })
    await check('GitHub: closing reference closed the issue, close is idempotent', () => {
      ok(gh, ['issue', 'close', String(made.issue)])
      expect(ok(gh, ['issue', 'view', String(made.issue)]).state === 'CLOSED', 'not closed')
    })
  } finally {
    deleteRemoteBranch(gh, made.head)
    spawnSync('git', ['-C', gh, 'switch', '-q', '--detach', 'origin/HEAD'])
    console.log(`cleanup: deleted branch ${made.head}; scratch issue ${made.issue ?? '-'} and PR ${made.pr ?? '-'} stay closed in the scratch repository`)
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`)
process.exit(results.fail ? 1 : 0)
