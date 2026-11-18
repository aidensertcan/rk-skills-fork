#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const GITHUB_REVIEW_BOTS = ['github-actions', 'claude']
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const ADO_DESCRIPTION_LIMIT = 4000
const ADO_RESOLVED_THREAD = new Set(['fixed', 'wontFix', 'closed', 'byDesign'])

class HostError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

const usage = () => `Usage: rk-host <command> [args]

Commands (output is JSON on stdout; errors are JSON on stderr):
  context
  whoami
  issue view <n> [--comments]
  issue create --title <t> --body-file <f> [--label <l>]... [--parent <n>] [--type <t>]
  issue edit <n> [--title <t>] [--body-file <f>] [--add-label <l>]... [--remove-label <l>]...
  issue comment <n> --body-file <f>
  issue close <n> [--reason completed|not_planned]
  issue list [--state open|closed|all] [--label <l>] [--search <s>] [--limit <n>]
  issue linked-prs <n>
  pr view <n>
  pr list [--state open|merged|closed|all] [--head <b>] [--base <b>] [--search <s>] [--limit <n>]
  pr create --title <t> --body-file <f> --base <b> --head <b> [--draft] [--issue <n>]...
  pr edit <n> [--title <t>] [--body-file <f>]
  pr comment <n> --body-file <f> [--active]
  pr comments <n>
  pr threads <n>
  pr reviews <n>
  pr reply <n> --thread <id> --body-file <f>
  pr resolve <n> --thread <id>
  pr review <n> --event approve|request-changes|comment [--body-file <f>]
  pr diff <n>
  pr checks <n>
  pr merge <n> --match-head <sha> [--squash|--merge|--rebase] [--delete-branch]
  pr link <n> --issue <n>
`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : (i++, next)
    if (flags[key] === undefined) flags[key] = value
    else flags[key] = [].concat(flags[key], value)
  }
  return { positional, flags }
}

const list = (value) => (value === undefined ? [] : [].concat(value))

function single(flags, key, required = false) {
  const value = flags[key]
  if (Array.isArray(value)) throw new HostError(`--${key} given more than once`, 2)
  if (value === true) throw new HostError(`--${key} needs a value`, 2)
  if (required && value === undefined) throw new HostError(`--${key} is required`, 2)
  return value
}

function number(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new HostError(`${name} must be a positive integer`, 2)
  return Number(value)
}

function readBody(flags, required) {
  const file = single(flags, 'body-file', required)
  if (file === undefined) return undefined
  if (!existsSync(file)) throw new HostError(`body file not found: ${file}`, 2)
  return readFileSync(file, 'utf8')
}

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  } catch (error) {
    if (options.allowFailure) return { failed: true, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '', status: error.status }
    const detail = (error.stderr?.toString() || error.message || '').trim()
    throw new HostError(`${cmd} ${args[0] ?? ''} failed: ${detail}`)
  }
}

const git = (args, options) => run('git', args, options)

function parseRemote(url) {
  const clean = url.trim().replace(/\.git$/, '')
  let m = clean.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+)$/i) || clean.match(/^git@github\.com:([^/]+)\/([^/]+)$/i)
  if (m) return { host: 'github', owner: m[1], repo: m[2], key: `github.com/${m[1]}/${m[2]}`.toLowerCase() }
  m = clean.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)$/i)
  if (!m) m = clean.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (!m) {
    const vs = clean.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)$/i)
    if (vs) m = vs
  }
  if (m) {
    const [org, project, repo] = [m[1], m[2], m[3]].map((part) => decodeURIComponent(part))
    return { host: 'ado', org, project, repo, key: `dev.azure.com/${org}/${project}/${repo}`.toLowerCase() }
  }
  throw new HostError(`unsupported git remote: ${url.trim()}`)
}

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new HostError(`invalid JSON in ${path}: ${error.message}`)
  }
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && !Array.isArray(out[key]) ? merge(out[key], value) : value
  }
  return out
}

function loadContext() {
  const root = git(['rev-parse', '--show-toplevel']).trim()
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const mainRoot = dirname(commonDir)
  const remoteName = process.env.RK_HOST_REMOTE || 'origin'
  const remoteUrl = git(['remote', 'get-url', remoteName]).trim()
  const remote = parseRemote(remoteUrl)
  const home = process.env.RK_SKILLS_HOME || join(homedir(), '.rk-skills')
  const userFile = readJson(join(home, 'config.json'))
  const userEntry = userFile?.repos ? Object.entries(userFile.repos).find(([key]) => key.toLowerCase() === remote.key)?.[1] : null
  const repoFile = readJson(join(root, '.rk-skills.json')) ?? (mainRoot !== root ? readJson(join(mainRoot, '.rk-skills.json')) : null)
  const defaults = remote.host === 'ado'
    ? { workItemType: 'Task', parentType: 'User Story', requireParent: true, trust: { bots: [], groups: [] }, branchPrefix: null, release: null }
    : { trust: { bots: [] }, branchPrefix: null, release: null }
  const config = merge(merge(defaults, userEntry), repoFile)
  if (config.host && config.host !== remote.host) throw new HostError(`config host ${config.host} does not match remote host ${remote.host}`)
  return { root, remote, config, remoteName }
}

function ghJson(args, options) {
  const out = run('gh', args, options)
  if (out?.failed) return out
  return out.trim() ? JSON.parse(out) : null
}

function makeGitHub(ctx) {
  const { owner, repo } = ctx.remote
  const nwo = `${owner}/${repo}`
  let me
  const whoami = () => (me ??= (() => {
    const u = ghJson(['api', 'user'])
    return { login: u.login, id: String(u.id), name: u.name ?? u.login }
  })())
  const botLogins = new Set([...GITHUB_REVIEW_BOTS, ...list(ctx.config.trust?.bots).map((b) => String(b).replace(/\[bot\]$/, ''))])
  const classify = (login, isBot, association) => {
    const bare = String(login ?? '').replace(/\[bot\]$/, '')
    if (isBot) return { association: 'BOT', trusted: botLogins.has(bare) }
    if (login && login === whoami().login) return { association: association ?? 'SELF', trusted: true }
    return { association: association ?? 'NONE', trusted: TRUSTED_ASSOCIATIONS.has(association) }
  }
  const restComment = (c) => ({
    id: String(c.id),
    author: { login: c.user?.login ?? null, id: c.user ? String(c.user.id) : null, name: c.user?.login ?? null },
    ...classify(c.user?.login, c.user?.type === 'Bot', c.author_association),
    body: c.body ?? '',
    createdAt: c.created_at,
    url: c.html_url,
  })
  const issueComments = (n) => ghJson(['api', '--paginate', '--slurp', `repos/${nwo}/issues/${n}/comments`]).flat().map(restComment)
  const prState = (p) => (p.state === 'MERGED' || p.mergedAt ? 'MERGED' : p.state)
  const prFields = 'number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,author,url,mergeable,mergedAt,closingIssuesReferences'
  const normPr = (p) => ({
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    state: prState(p),
    isDraft: !!p.isDraft,
    headRefName: p.headRefName,
    headRefOid: p.headRefOid,
    baseRefName: p.baseRefName,
    author: { login: p.author?.login ?? null },
    url: p.url,
    mergeable: p.mergeable ?? null,
    closingIssues: (p.closingIssuesReferences ?? []).map((i) => i.number),
  })
  const threadsQuery = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){ repository(owner:$owner,name:$repo){ pullRequest(number:$pr){ reviewThreads(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id isResolved isOutdated path line originalLine comments(first:100){ nodes{ databaseId author{login __typename} authorAssociation createdAt url body } } } } } } }`
  const threads = (n) => {
    const out = []
    let after = null
    do {
      const args = ['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${n}`, '-f', `query=${threadsQuery}`]
      if (after) args.push('-f', `after=${after}`)
      const page = ghJson(args).data.repository.pullRequest.reviewThreads
      for (const t of page.nodes) {
        out.push({
          id: t.id,
          path: t.path,
          line: t.line ?? t.originalLine ?? null,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          status: t.isResolved ? 'resolved' : 'active',
          comments: t.comments.nodes.map((c) => ({
            id: String(c.databaseId),
            author: { login: c.author?.login ?? null, id: null, name: c.author?.login ?? null },
            ...classify(c.author?.login, c.author?.__typename === 'Bot', c.authorAssociation),
            body: c.body ?? '',
            createdAt: c.createdAt,
            url: c.url,
          })),
        })
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (after)
    return out
  }
  return {
    context: () => {
      const r = ghJson(['repo', 'view', nwo, '--json', 'nameWithOwner,defaultBranchRef,url'])
      return { host: 'github', owner, repo, nameWithOwner: r.nameWithOwner, defaultBranch: r.defaultBranchRef?.name ?? null, url: r.url, config: ctx.config }
    },
    whoami,
    issueView: (n, withComments) => {
      const i = ghJson(['issue', 'view', String(n), '-R', nwo, '--json', 'number,title,body,state,labels,assignees,milestone,author,createdAt,updatedAt,url'])
      return {
        number: i.number, title: i.title, body: i.body ?? '', bodyFormat: 'markdown', state: i.state, rawState: i.state, type: 'Issue',
        labels: i.labels.map((l) => l.name), assignees: i.assignees.map((a) => a.login), milestone: i.milestone?.title ?? null,
        parent: null, author: { login: i.author?.login ?? null }, createdAt: i.createdAt, updatedAt: i.updatedAt, url: i.url,
        ...(withComments ? { comments: issueComments(n) } : {}),
      }
    },
    issueCreate: ({ title, body, labels, parent, type }) => {
      if (parent !== undefined) throw new HostError('--parent is not supported on GitHub; reference the parent issue in the body', 3)
      if (type !== undefined) throw new HostError('--type is not supported on GitHub', 3)
      const args = ['issue', 'create', '-R', nwo, '--title', title, '--body-file', '-']
      for (const l of labels) args.push('--label', l)
      const url = run('gh', args, { input: body }).trim().split(/\s+/).pop()
      return { number: Number(url.split('/').pop()), url }
    },
    issueEdit: (n, { title, body, addLabels, removeLabels }) => {
      const args = ['issue', 'edit', String(n), '-R', nwo]
      if (title !== undefined) args.push('--title', title)
      if (body !== undefined) args.push('--body-file', '-')
      for (const l of addLabels) args.push('--add-label', l)
      for (const l of removeLabels) args.push('--remove-label', l)
      run('gh', args, { input: body ?? '' })
      return { number: n, updated: true }
    },
    issueComment: (n, body) => {
      const c = ghJson(['api', '-X', 'POST', `repos/${nwo}/issues/${n}/comments`, '-F', 'body=@-'], { input: body })
      return { id: String(c.id), url: c.html_url }
    },
    issueClose: (n, reason) => {
      run('gh', ['issue', 'close', String(n), '-R', nwo, '--reason', reason === 'not_planned' ? 'not planned' : 'completed'])
      return { number: n, state: 'CLOSED' }
    },
    issueList: ({ state, label, search, limit }) => {
      const args = ['issue', 'list', '-R', nwo, '--state', state, '--limit', String(limit), '--json', 'number,title,state,labels,updatedAt,url']
      if (label) args.push('--label', label)
      if (search) args.push('--search', search)
      return ghJson(args).map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels.map((l) => l.name), updatedAt: i.updatedAt, url: i.url }))
    },
    issueLinkedPrs: (n) => ghJson(['api', '--paginate', '--slurp', `repos/${nwo}/issues/${n}/timeline`]).flat()
      .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request)
      .map((e) => {
        const i = e.source.issue
        const repoName = i.repository_url.split('/').slice(-2).join('/')
        return { repo: repoName, number: i.number, state: i.pull_request.merged_at ? 'MERGED' : i.state.toUpperCase(), merged: !!i.pull_request.merged_at, url: i.html_url }
      }),
    prView: (n) => normPr(ghJson(['pr', 'view', String(n), '-R', nwo, '--json', prFields])),
    prList: ({ state, head, base, search, limit }) => {
      const args = ['pr', 'list', '-R', nwo, '--state', state, '--limit', String(limit), '--json', 'number,title,state,headRefName,baseRefName,author,url,mergedAt,isDraft']
      if (head) args.push('--head', head)
      if (base) args.push('--base', base)
      if (search) args.push('--search', search)
      return ghJson(args).map((p) => ({ number: p.number, title: p.title, state: prState(p), isDraft: !!p.isDraft, headRefName: p.headRefName, baseRefName: p.baseRefName, author: { login: p.author?.login ?? null }, url: p.url }))
    },
    prCreate: ({ title, body, base, head, draft, issues }) => {
      if (issues.length) throw new HostError('--issue is not supported on GitHub; write a "Closes #<n>" line in the body', 3)
      const args = ['pr', 'create', '-R', nwo, '--title', title, '--body-file', '-', '--base', base, '--head', head]
      if (draft) args.push('--draft')
      const url = run('gh', args, { input: body }).trim().split(/\s+/).pop()
      return { number: Number(url.split('/').pop()), url }
    },
    prEdit: (n, { title, body }) => {
      const args = ['pr', 'edit', String(n), '-R', nwo]
      if (title !== undefined) args.push('--title', title)
      if (body !== undefined) args.push('--body-file', '-')
      run('gh', args, { input: body ?? '' })
      return { number: n, updated: true }
    },
    prComment: (n, body) => {
      const c = ghJson(['api', '-X', 'POST', `repos/${nwo}/issues/${n}/comments`, '-F', 'body=@-'], { input: body })
      return { id: String(c.id), url: c.html_url }
    },
    prComments: (n) => issueComments(n),
    prThreads: threads,
    prReviews: (n) => ghJson(['api', '--paginate', '--slurp', `repos/${nwo}/pulls/${n}/reviews`]).flat().map((r) => ({
      id: String(r.id),
      author: { login: r.user?.login ?? null, id: r.user ? String(r.user.id) : null, name: r.user?.login ?? null },
      ...classify(r.user?.login, r.user?.type === 'Bot', r.author_association),
      state: r.state, body: r.body ?? '', submittedAt: r.submitted_at, url: r.html_url,
    })),
    prReply: (n, threadId, body) => {
      const t = threads(n).find((x) => x.id === threadId)
      if (!t) throw new HostError(`thread ${threadId} not found on PR ${n}`)
      const c = ghJson(['api', '-X', 'POST', `repos/${nwo}/pulls/${n}/comments/${t.comments[0].id}/replies`, '-F', 'body=@-'], { input: body })
      return { id: String(c.id), url: c.html_url }
    },
    prResolve: (n, threadId) => {
      const r = ghJson(['api', 'graphql', '-f', 'query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }', '-f', `id=${threadId}`])
      return { id: r.data.resolveReviewThread.thread.id, isResolved: r.data.resolveReviewThread.thread.isResolved }
    },
    prReview: (n, event, body) => {
      const flag = { approve: '--approve', 'request-changes': '--request-changes', comment: '--comment' }[event]
      const args = ['pr', 'review', String(n), '-R', nwo, flag]
      if (body !== undefined) args.push('--body-file', '-')
      run('gh', args, { input: body ?? '' })
      return { number: n, event }
    },
    prDiff: (n) => run('gh', ['pr', 'diff', String(n), '-R', nwo]),
    prChecks: (n) => {
      const out = run('gh', ['pr', 'checks', String(n), '-R', nwo, '--json', 'name,state,bucket,link,workflow'], { allowFailure: true })
      const text = out.failed ? out.stdout : out
      if (!text.trim()) {
        if (out.failed && /no checks reported/i.test(out.stderr)) return []
        if (out.failed) throw new HostError(`gh pr checks failed: ${out.stderr.trim()}`)
        return []
      }
      const map = { pass: 'SUCCESS', fail: 'FAILURE', pending: 'PENDING', skipping: 'SKIPPED', cancel: 'FAILURE' }
      return JSON.parse(text).map((c) => ({ name: c.workflow ? `${c.workflow} / ${c.name}` : c.name, state: map[c.bucket] ?? 'PENDING', required: null, url: c.link ?? null }))
    },
    prMerge: (n, { sha, method, deleteBranch }) => {
      const args = ['pr', 'merge', String(n), '-R', nwo, `--${method}`, '--match-head-commit', sha]
      if (deleteBranch) args.push('--delete-branch')
      run('gh', args)
      return { number: n, merged: true, method }
    },
    prLink: () => {
      throw new HostError('pr link is not supported on GitHub; write a "Closes #<n>" line in the PR body', 3)
    },
  }
}

function makeAdo(ctx) {
  const { org, project, repo } = ctx.remote
  const base = `https://dev.azure.com/${encodeURIComponent(org)}`
  const proj = `${base}/${encodeURIComponent(project)}`
  const boardsProject = ctx.config.boardsProject ?? project
  const wit = `${base}/${encodeURIComponent(boardsProject)}`
  let token
  let repoInfo
  let me
  let trustedIds
  const stateCache = new Map()
  const getToken = () => {
    if (token) return token
    if (process.env.RK_HOST_ADO_TOKEN) return (token = process.env.RK_HOST_ADO_TOKEN)
    const args = ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']
    const out = process.platform === 'win32'
      ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `az ${args.join(' ')}`])
      : run('az', args)
    token = out.trim()
    if (!token) throw new HostError('az returned no Azure DevOps token; run az login')
    return token
  }
  const api = async (method, url, body, contentType = 'application/json') => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    const isJson = /json/i.test(res.headers.get('content-type') ?? '')
    if (res.status === 203 || res.status === 401 || (text && !isJson)) {
      throw new HostError(`Azure DevOps rejected the credentials for ${method} ${url.replace(/\?.*/, '')} (HTTP ${res.status}); run az login, or check RK_HOST_ADO_TOKEN`)
    }
    if (!res.ok) {
      let message = text
      try { message = JSON.parse(text).message ?? text } catch {}
      throw new HostError(`Azure DevOps ${method} ${url.replace(/\?.*/, '')} returned ${res.status}: ${String(message).slice(0, 500)}`)
    }
    return text ? JSON.parse(text) : null
  }
  const getRepo = async () => (repoInfo ??= await api('GET', `${proj}/_apis/git/repositories/${encodeURIComponent(repo)}?api-version=7.1`))
  const repoApi = async (path) => `${proj}/_apis/git/repositories/${(await getRepo()).id}${path}`
  const whoami = async () => {
    if (me) return me
    const cd = await api('GET', `${base}/_apis/connectionData`)
    const u = cd.authenticatedUser
    if (!u?.id || /^a{8}-a{4}-a{4}-a{4}-a{12}$/i.test(u.id) || u.providerDisplayName === 'Anonymous') throw new HostError('Azure DevOps treated this request as anonymous; run az login, or check RK_HOST_ADO_TOKEN')
    me = { login: u.properties?.Account?.$value ?? u.providerDisplayName, id: u.id, name: u.providerDisplayName }
    return me
  }
  const trustSet = async () => {
    if (trustedIds) return trustedIds
    const ids = new Set(list(ctx.config.trust?.bots).map((b) => String(b).toLowerCase()))
    for (const group of list(ctx.config.trust?.groups)) {
      let skip = 0
      for (;;) {
        const page = await api('GET', `${base}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(group)}/members?$top=100&$skip=${skip}&api-version=7.1`)
        for (const m of page.value) ids.add(String(m.identity.id).toLowerCase())
        if (page.value.length < 100) break
        skip += 100
      }
    }
    return (trustedIds = ids)
  }
  const classify = async (author) => {
    const id = String(author?.id ?? '').toLowerCase()
    const bots = new Set(list(ctx.config.trust?.bots).map((b) => String(b).toLowerCase()))
    if (bots.has(id)) return { association: 'BOT', trusted: true }
    if (id && id === String((await whoami()).id).toLowerCase()) return { association: 'SELF', trusted: true }
    if ((await trustSet()).has(id)) return { association: 'MEMBER', trusted: true }
    return { association: String(author?.descriptor ?? '').startsWith('svc.') ? 'BOT' : 'NONE', trusted: false }
  }
  const person = (p) => (p ? { login: p.uniqueName || p.displayName, id: p.id, name: p.displayName } : null)
  const states = async (type) => {
    if (!stateCache.has(type)) stateCache.set(type, (await api('GET', `${wit}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`)).value)
    return stateCache.get(type)
  }
  const normState = async (type, state) => {
    const s = (await states(type)).find((x) => x.name === state)
    return s && (s.category === 'Completed' || s.category === 'Removed') ? 'CLOSED' : 'OPEN'
  }
  const tags = (value) => (value ? value.split(';').map((t) => t.trim()).filter(Boolean) : [])
  const toWit = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const fromWit = (text, format) => String(format).toLowerCase() === 'markdown'
    ? text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    : text
  const wiUrl = (id) => `${wit}/_workitems/edit/${id}`
  const getWi = (id) => api('GET', `${wit}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.2-preview.3`)
  const wiComments = async (id) => {
    const out = []
    let token2 = null
    do {
      const page = await api('GET', `${wit}/_apis/wit/workItems/${id}/comments?api-version=7.2-preview.4${token2 ? `&continuationToken=${encodeURIComponent(token2)}` : ''}`)
      for (const c of page.comments) {
        if (c.isDeleted) continue
        out.push({ id: String(c.id), author: person(c.createdBy), ...(await classify(c.createdBy)), body: fromWit(c.text ?? '', c.format ?? 'html'), bodyFormat: String(c.format ?? 'html').toLowerCase(), createdAt: c.createdDate, url: `${wiUrl(id)}#${c.id}` })
      }
      token2 = page.continuationToken
    } while (token2)
    return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }
  const patchWi = (id, ops) => api('PATCH', `${wit}/_apis/wit/workitems/${id}?api-version=7.2-preview.3`, ops, 'application/json-patch+json')
  const prUrl = async (id) => `${proj}/_git/${encodeURIComponent((await getRepo()).name)}/pullrequest/${id}`
  const strip = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '')
  const prStateOf = (status) => ({ active: 'OPEN', completed: 'MERGED', abandoned: 'CLOSED' }[status] ?? String(status).toUpperCase())
  const normPr = async (p, workItems) => ({
    number: p.pullRequestId,
    title: p.title,
    body: p.description ?? '',
    state: prStateOf(p.status),
    isDraft: !!p.isDraft,
    headRefName: strip(p.sourceRefName),
    headRefOid: p.lastMergeSourceCommit?.commitId ?? null,
    baseRefName: strip(p.targetRefName),
    author: person(p.createdBy),
    url: await prUrl(p.pullRequestId),
    mergeable: p.mergeStatus === 'succeeded' ? 'MERGEABLE' : p.mergeStatus === 'conflicts' ? 'CONFLICTING' : 'UNKNOWN',
    closingIssues: workItems ?? [],
  })
  const prWorkItems = async (id) => (await api('GET', await repoApi(`/pullRequests/${id}/workitems?api-version=7.1`))).value.map((w) => Number(w.id))
  const rawThreads = async (id) => (await api('GET', await repoApi(`/pullRequests/${id}/threads?api-version=7.1`))).value
    .filter((t) => !t.isDeleted && t.comments?.length && t.comments[0].commentType !== 'system')
  const normComment = async (c, prId, threadId) => ({
    id: String(c.id), threadId: String(threadId), author: person(c.author), ...(await classify(c.author)),
    body: c.content ?? '', createdAt: c.publishedDate, url: `${await prUrl(prId)}?discussionId=${threadId}`,
  })
  const checkDescription = (body) => {
    if (body !== undefined && body.length > ADO_DESCRIPTION_LIMIT) throw new HostError(`Azure DevOps PR descriptions are limited to ${ADO_DESCRIPTION_LIMIT} characters; this body has ${body.length}. Shorten it or move detail into a PR comment.`, 3)
  }
  const wiql = async (query, limit) => {
    const r = await api('POST', `${wit}/_apis/wit/wiql?$top=${limit}&api-version=7.1`, { query })
    const ids = r.workItems.map((w) => w.id).slice(0, limit)
    const out = []
    for (let i = 0; i < ids.length; i += 200) {
      const batch = await api('POST', `${wit}/_apis/wit/workitemsbatch?api-version=7.1`, { ids: ids.slice(i, i + 200), fields: ['System.Id', 'System.Title', 'System.State', 'System.Tags', 'System.ChangedDate', 'System.WorkItemType'] })
      out.push(...batch.value)
    }
    return out
  }
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`
  return {
    context: async () => {
      const r = await getRepo()
      return { host: 'ado', org, project, boardsProject, repo: r.name, nameWithOwner: `${org}/${project}/${r.name}`, defaultBranch: strip(r.defaultBranch), url: r.webUrl, config: ctx.config }
    },
    whoami,
    issueView: async (n, withComments) => {
      const w = await getWi(n)
      const f = w.fields
      const parentRel = (w.relations ?? []).find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse')
      return {
        number: w.id, title: f['System.Title'], body: fromWit(f['System.Description'] ?? '', w.multilineFieldsFormat?.['System.Description'] ?? 'html'), bodyFormat: String(w.multilineFieldsFormat?.['System.Description'] ?? 'html').toLowerCase(),
        state: await normState(f['System.WorkItemType'], f['System.State']), rawState: f['System.State'], type: f['System.WorkItemType'],
        labels: tags(f['System.Tags']), assignees: f['System.AssignedTo'] ? [f['System.AssignedTo'].uniqueName] : [], milestone: f['System.IterationPath'] ?? null,
        parent: parentRel ? Number(parentRel.url.split('/').pop()) : null, author: person(f['System.CreatedBy']), createdAt: f['System.CreatedDate'], updatedAt: f['System.ChangedDate'], url: wiUrl(w.id),
        ...(withComments ? { comments: await wiComments(n) } : {}),
      }
    },
    issueCreate: async ({ title, body, labels, parent, type }) => {
      const wiType = type ?? ctx.config.workItemType
      if (ctx.config.requireParent && wiType === ctx.config.workItemType && parent === undefined) throw new HostError(`--parent is required: this repository files each ${wiType} under an existing ${ctx.config.parentType}`, 2)
      const ops = [
        { op: 'add', path: '/fields/System.Title', value: title },
        { op: 'add', path: '/fields/System.Description', value: toWit(body) },
        { op: 'add', path: '/multilineFieldsFormat/System.Description', value: 'markdown' },
      ]
      if (labels.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: labels.join('; ') })
      if (ctx.config.areaPath) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: ctx.config.areaPath })
      if (ctx.config.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: ctx.config.iterationPath })
      if (parent !== undefined) {
        const p = await getWi(parent)
        if (wiType === ctx.config.workItemType && ctx.config.parentType && p.fields['System.WorkItemType'] !== ctx.config.parentType) throw new HostError(`parent ${parent} is a ${p.fields['System.WorkItemType']}, not a ${ctx.config.parentType}`, 2)
        ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: p.url } })
      }
      const w = await api('POST', `${wit}/_apis/wit/workitems/$${encodeURIComponent(wiType)}?api-version=7.2-preview.3`, ops, 'application/json-patch+json')
      return { number: w.id, url: wiUrl(w.id), parent: parent ?? null, type: wiType }
    },
    issueEdit: async (n, { title, body, addLabels, removeLabels }) => {
      const w = await getWi(n)
      const ops = [{ op: 'test', path: '/rev', value: w.rev }]
      if (title !== undefined) ops.push({ op: 'add', path: '/fields/System.Title', value: title })
      if (body !== undefined) {
        ops.push({ op: 'add', path: '/fields/System.Description', value: toWit(body) })
        ops.push({ op: 'add', path: '/multilineFieldsFormat/System.Description', value: 'markdown' })
      }
      if (addLabels.length || removeLabels.length) {
        const current = tags(w.fields['System.Tags'])
        const drop = new Set(removeLabels.map((l) => l.toLowerCase()))
        const next = [...current.filter((t) => !drop.has(t.toLowerCase()))]
        for (const l of addLabels) if (!next.some((t) => t.toLowerCase() === l.toLowerCase())) next.push(l)
        ops.push({ op: current.length ? 'replace' : 'add', path: '/fields/System.Tags', value: next.join('; ') })
      }
      if (ops.length === 1) throw new HostError('issue edit needs --title, --body-file, --add-label, or --remove-label', 2)
      const r = await patchWi(n, ops)
      return { number: n, updated: true, rev: r.rev }
    },
    issueComment: async (n, body) => {
      const c = await api('POST', `${wit}/_apis/wit/workItems/${n}/comments?format=markdown&api-version=7.2-preview.4`, { text: toWit(body) })
      return { id: String(c.id), url: `${wiUrl(n)}#${c.id}` }
    },
    issueClose: async (n, reason) => {
      const w = await getWi(n)
      const category = reason === 'not_planned' ? 'Removed' : 'Completed'
      const target = (await states(w.fields['System.WorkItemType'])).find((s) => s.category === category)
      if (!target) throw new HostError(`work item type ${w.fields['System.WorkItemType']} has no ${category} state`)
      await patchWi(n, [{ op: 'test', path: '/rev', value: w.rev }, { op: 'add', path: '/fields/System.State', value: target.name }])
      return { number: n, state: 'CLOSED', rawState: target.name }
    },
    issueList: async ({ state, label, search, limit, type }) => {
      const wiType = type ?? ctx.config.workItemType
      const clauses = [`[System.TeamProject] = @project`, `[System.WorkItemType] = ${quote(wiType)}`]
      if (state !== 'all') {
        const closed = (s) => s.category === 'Completed' || s.category === 'Removed'
        const names = (await states(wiType)).filter((s) => (state === 'closed' ? closed(s) : !closed(s))).map((s) => quote(s.name))
        if (!names.length) return []
        clauses.push(`[System.State] IN (${names.join(', ')})`)
      }
      if (ctx.config.areaPath) clauses.push(`[System.AreaPath] UNDER ${quote(ctx.config.areaPath)}`)
      if (label) clauses.push(`[System.Tags] CONTAINS ${quote(label)}`)
      if (search) clauses.push(`[System.Title] CONTAINS ${quote(search)}`)
      const rows = await wiql(`SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`, limit)
      const out = []
      for (const w of rows) {
        const f = w.fields
        out.push({ number: w.id, title: f['System.Title'], state: await normState(f['System.WorkItemType'], f['System.State']), rawState: f['System.State'], labels: tags(f['System.Tags']), updatedAt: f['System.ChangedDate'], url: wiUrl(w.id) })
      }
      return out
    },
    issueLinkedPrs: async (n) => {
      const w = await getWi(n)
      const out = []
      for (const r of w.relations ?? []) {
        const m = r.rel === 'ArtifactLink' && decodeURIComponent(r.url).match(/^vstfs:\/\/\/Git\/PullRequestId\/([^/]+)\/([^/]+)\/(\d+)$/i)
        if (!m) continue
        const p = await api('GET', `${base}/_apis/git/repositories/${m[2]}/pullrequests/${m[3]}?api-version=7.1`)
        out.push({ repo: `${org}/${p.repository.project.name}/${p.repository.name}`, number: p.pullRequestId, state: prStateOf(p.status), merged: p.status === 'completed', url: `${base}/${encodeURIComponent(p.repository.project.name)}/_git/${encodeURIComponent(p.repository.name)}/pullrequest/${p.pullRequestId}` })
      }
      return out
    },
    prView: async (n) => normPr(await api('GET', await repoApi(`/pullrequests/${n}?api-version=7.1`)), await prWorkItems(n)),
    prList: async ({ state, head, base: baseRef, search, limit }) => {
      const status = { open: 'active', merged: 'completed', closed: 'abandoned', all: 'all' }[state]
      const params = [`searchCriteria.status=${status}`, `$top=${search ? Math.max(limit * 5, 100) : limit}`, 'api-version=7.1']
      if (head) params.push(`searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${head}`)}`)
      if (baseRef) params.push(`searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${baseRef}`)}`)
      const r = await api('GET', await repoApi(`/pullrequests?${params.join('&')}`))
      const needle = search ? String(search).toLowerCase() : null
      const out = []
      for (const p of r.value) {
        if (needle && !`${p.title}\n${p.description ?? ''}`.toLowerCase().includes(needle)) continue
        out.push({ number: p.pullRequestId, title: p.title, state: prStateOf(p.status), isDraft: !!p.isDraft, headRefName: strip(p.sourceRefName), baseRefName: strip(p.targetRefName), author: person(p.createdBy), url: await prUrl(p.pullRequestId) })
        if (out.length >= limit) break
      }
      return out
    },
    prCreate: async ({ title, body, base: baseRef, head, draft, issues }) => {
      checkDescription(body)
      const p = await api('POST', await repoApi('/pullrequests?api-version=7.1'), {
        sourceRefName: `refs/heads/${head}`, targetRefName: `refs/heads/${baseRef}`, title, description: body, isDraft: !!draft,
        workItemRefs: issues.map((id) => ({ id: String(id) })),
      })
      return { number: p.pullRequestId, url: await prUrl(p.pullRequestId), linkedIssues: issues }
    },
    prEdit: async (n, { title, body }) => {
      checkDescription(body)
      const patch = {}
      if (title !== undefined) patch.title = title
      if (body !== undefined) patch.description = body
      if (!Object.keys(patch).length) throw new HostError('pr edit needs --title or --body-file', 2)
      await api('PATCH', await repoApi(`/pullrequests/${n}?api-version=7.1`), patch)
      return { number: n, updated: true }
    },
    prComment: async (n, body, active) => {
      const t = await api('POST', await repoApi(`/pullRequests/${n}/threads?api-version=7.1`), { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: active ? 'active' : 'closed' })
      return { id: String(t.id), url: `${await prUrl(n)}?discussionId=${t.id}` }
    },
    prComments: async (n) => {
      const out = []
      for (const t of await rawThreads(n)) {
        if (t.threadContext) continue
        for (const c of t.comments) if (!c.isDeleted && c.commentType !== 'system') out.push(await normComment(c, n, t.id))
      }
      return out
    },
    prThreads: async (n) => {
      const out = []
      for (const t of await rawThreads(n)) {
        if (!t.threadContext) continue
        const ctxt = t.threadContext
        out.push({
          id: String(t.id), path: ctxt.filePath?.replace(/^\//, '') ?? null, line: ctxt.rightFileStart?.line ?? ctxt.leftFileStart?.line ?? null,
          isResolved: ADO_RESOLVED_THREAD.has(t.status), isOutdated: false, status: t.status,
          comments: await Promise.all(t.comments.filter((c) => !c.isDeleted).map((c) => normComment(c, n, t.id))),
        })
      }
      return out
    },
    prReviews: async (n) => {
      const r = await api('GET', await repoApi(`/pullRequests/${n}/reviewers?api-version=7.1`))
      const vote = { 10: 'APPROVED', 5: 'APPROVED_WITH_SUGGESTIONS', 0: 'NONE', '-5': 'CHANGES_REQUESTED', '-10': 'REJECTED' }
      return Promise.all(r.value.map(async (v) => ({ id: v.id, author: person(v), ...(await classify(v)), state: vote[v.vote] ?? String(v.vote), vote: v.vote, isRequired: !!v.isRequired, body: '', submittedAt: null, url: null })))
    },
    prReply: async (n, threadId, body) => {
      const t = await api('GET', await repoApi(`/pullRequests/${n}/threads/${threadId}?api-version=7.1`))
      const c = await api('POST', await repoApi(`/pullRequests/${n}/threads/${threadId}/comments?api-version=7.1`), { parentCommentId: t.comments[0].id, content: body, commentType: 1 })
      return { id: String(c.id), threadId: String(threadId), url: `${await prUrl(n)}?discussionId=${threadId}` }
    },
    prResolve: async (n, threadId) => {
      const t = await api('PATCH', await repoApi(`/pullRequests/${n}/threads/${threadId}?api-version=7.1`), { status: 'fixed' })
      return { id: String(t.id), isResolved: true, status: t.status }
    },
    prReview: async (n, event, body) => {
      let thread = null
      if (body !== undefined) {
        const t = await api('POST', await repoApi(`/pullRequests/${n}/threads?api-version=7.1`), { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: event === 'request-changes' ? 'active' : 'closed' })
        thread = String(t.id)
      }
      if (event !== 'comment') {
        const u = await whoami()
        await api('PUT', await repoApi(`/pullRequests/${n}/reviewers/${u.id}?api-version=7.1`), { vote: event === 'approve' ? 10 : -5 })
      }
      return { number: n, event, threadId: thread }
    },
    prDiff: async (n) => {
      const p = await api('GET', await repoApi(`/pullrequests/${n}?api-version=7.1`))
      const target = p.lastMergeTargetCommit?.commitId
      const source = p.lastMergeSourceCommit?.commitId
      if (!target || !source) throw new HostError(`PR ${n} has no merge commits to diff`)
      for (const sha of [target, source]) {
        if (git(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true }).failed) git(['fetch', '--quiet', ctx.remoteName, sha])
      }
      return git(['diff', '--no-color', `${target}...${source}`])
    },
    prChecks: async (n) => {
      const r = await getRepo()
      const evals = await api('GET', `${proj}/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${r.project.id}/${n}`)}&api-version=7.1-preview.1`)
      const map = { approved: 'SUCCESS', rejected: 'FAILURE', broken: 'FAILURE', running: 'PENDING', queued: 'PENDING', notApplicable: 'SKIPPED' }
      const out = evals.value.map((e) => ({
        name: [e.configuration?.type?.displayName, e.configuration?.settings?.displayName].filter(Boolean).join(': '),
        state: map[e.status] ?? 'PENDING', required: !!e.configuration?.isBlocking, url: null, source: 'policy',
      }))
      const statuses = (await api('GET', await repoApi(`/pullRequests/${n}/statuses?api-version=7.1`))).value
      const latest = new Map()
      for (const s of statuses) {
        const key = `${s.context?.genre ?? ''}/${s.context?.name ?? ''}`
        if (!latest.has(key) || s.id > latest.get(key).id) latest.set(key, s)
      }
      const smap = { succeeded: 'SUCCESS', failed: 'FAILURE', error: 'FAILURE', pending: 'PENDING', notSet: 'PENDING', notApplicable: 'SKIPPED' }
      for (const s of latest.values()) out.push({ name: [s.context?.genre, s.context?.name].filter(Boolean).join('/'), state: smap[s.state] ?? 'PENDING', required: null, url: s.targetUrl ?? null, source: 'status' })
      return out
    },
    prMerge: async (n, { sha, method, deleteBranch }) => {
      const p = await api('GET', await repoApi(`/pullrequests/${n}?api-version=7.1`))
      if (p.status !== 'active') throw new HostError(`PR ${n} is ${p.status}, not active`)
      if (p.lastMergeSourceCommit?.commitId !== sha) throw new HostError(`PR ${n} head is ${p.lastMergeSourceCommit?.commitId}, not ${sha}; refusing to merge`)
      const strategy = { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' }[method]
      const done = await api('PATCH', await repoApi(`/pullrequests/${n}?api-version=7.1`), {
        status: 'completed', lastMergeSourceCommit: { commitId: sha },
        completionOptions: { mergeStrategy: strategy, deleteSourceBranch: !!deleteBranch, transitionWorkItems: true },
      })
      let pr = done
      for (let i = 0; pr.status !== 'completed' && i < 30; i++) {
        if (['conflicts', 'rejectedByPolicy', 'failure'].includes(pr.mergeStatus)) break
        await new Promise((resolve) => setTimeout(resolve, 2000))
        pr = await api('GET', await repoApi(`/pullrequests/${n}?api-version=7.1`))
      }
      if (pr.status !== 'completed') throw new HostError(`PR ${n} did not complete: status ${pr.status}, merge status ${pr.mergeStatus}${pr.mergeFailureMessage ? `, ${pr.mergeFailureMessage}` : ''} (a branch policy or conflict may block it)`)
      return { number: n, merged: true, method, mergeCommit: pr.lastMergeCommit?.commitId ?? null }
    },
    prLink: async (n, issue) => {
      const r = await getRepo()
      const w = await getWi(issue)
      const url = `vstfs:///Git/PullRequestId/${r.project.id}%2F${r.id}%2F${n}`
      if ((w.relations ?? []).some((x) => x.rel === 'ArtifactLink' && x.url.toLowerCase() === url.toLowerCase())) return { number: n, issue, linked: true, existing: true }
      await patchWi(issue, [{ op: 'test', path: '/rev', value: w.rev }, { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request' } } }])
      return { number: n, issue, linked: true, existing: false }
    },
  }
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv)
  const [group, action, target] = positional
  if (!group || group === 'help' || flags.help) {
    process.stdout.write(usage())
    return
  }
  const key = ['context', 'whoami'].includes(group) ? group : `${group} ${action}`
  const known = ['context', 'whoami', 'issue view', 'issue create', 'issue edit', 'issue comment', 'issue close', 'issue list', 'issue linked-prs', 'pr view', 'pr list', 'pr create', 'pr edit', 'pr comment', 'pr comments', 'pr threads', 'pr reviews', 'pr reply', 'pr resolve', 'pr review', 'pr diff', 'pr checks', 'pr merge', 'pr link']
  if (!known.includes(key)) throw new HostError(`unknown command: ${[group, action].filter(Boolean).join(' ')}\n${usage()}`, 2)
  const ctx = loadContext()
  const h = ctx.remote.host === 'github' ? makeGitHub(ctx) : makeAdo(ctx)
  const state = (allowed, fallback) => {
    const s = single(flags, 'state') ?? fallback
    if (!allowed.includes(s)) throw new HostError(`--state must be one of ${allowed.join(', ')}`, 2)
    return s
  }
  const limit = () => number(single(flags, 'limit') ?? 30, '--limit')
  const route = {
    'context': () => h.context(),
    'whoami': () => h.whoami(),
    'issue view': () => h.issueView(number(target, 'issue number'), !!flags.comments),
    'issue create': () => h.issueCreate({
      title: single(flags, 'title', true), body: readBody(flags, true), labels: list(flags.label),
      parent: flags.parent === undefined ? undefined : number(single(flags, 'parent'), '--parent'), type: single(flags, 'type'),
    }),
    'issue edit': () => h.issueEdit(number(target, 'issue number'), { title: single(flags, 'title'), body: readBody(flags, false), addLabels: list(flags['add-label']), removeLabels: list(flags['remove-label']) }),
    'issue comment': () => h.issueComment(number(target, 'issue number'), readBody(flags, true)),
    'issue close': () => {
      const reason = single(flags, 'reason') ?? 'completed'
      if (!['completed', 'not_planned'].includes(reason)) throw new HostError('--reason must be completed or not_planned', 2)
      return h.issueClose(number(target, 'issue number'), reason)
    },
    'issue list': () => h.issueList({ state: state(['open', 'closed', 'all'], 'open'), label: single(flags, 'label'), search: single(flags, 'search'), limit: limit(), type: single(flags, 'type') }),
    'issue linked-prs': () => h.issueLinkedPrs(number(target, 'issue number')),
    'pr view': () => h.prView(number(target, 'PR number')),
    'pr list': () => h.prList({ state: state(['open', 'merged', 'closed', 'all'], 'open'), head: single(flags, 'head'), base: single(flags, 'base'), search: single(flags, 'search'), limit: limit() }),
    'pr create': () => h.prCreate({
      title: single(flags, 'title', true), body: readBody(flags, true), base: single(flags, 'base', true), head: single(flags, 'head', true),
      draft: !!flags.draft, issues: list(flags.issue).map((i) => number(i, '--issue')),
    }),
    'pr edit': () => h.prEdit(number(target, 'PR number'), { title: single(flags, 'title'), body: readBody(flags, false) }),
    'pr comment': () => h.prComment(number(target, 'PR number'), readBody(flags, true), !!flags.active),
    'pr comments': () => h.prComments(number(target, 'PR number')),
    'pr threads': () => h.prThreads(number(target, 'PR number')),
    'pr reviews': () => h.prReviews(number(target, 'PR number')),
    'pr reply': () => h.prReply(number(target, 'PR number'), String(single(flags, 'thread', true)), readBody(flags, true)),
    'pr resolve': () => h.prResolve(number(target, 'PR number'), String(single(flags, 'thread', true))),
    'pr review': () => {
      const event = single(flags, 'event', true)
      if (!['approve', 'request-changes', 'comment'].includes(event)) throw new HostError('--event must be approve, request-changes, or comment', 2)
      const body = readBody(flags, event !== 'approve')
      return h.prReview(number(target, 'PR number'), event, body)
    },
    'pr diff': () => h.prDiff(number(target, 'PR number')),
    'pr checks': () => h.prChecks(number(target, 'PR number')),
    'pr merge': () => {
      const methods = ['squash', 'merge', 'rebase'].filter((m) => flags[m])
      if (methods.length > 1) throw new HostError('choose one of --squash, --merge, --rebase', 2)
      const sha = single(flags, 'match-head', true)
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new HostError('--match-head must be a full 40-character commit SHA', 2)
      return h.prMerge(number(target, 'PR number'), { sha, method: methods[0] ?? 'squash', deleteBranch: !!flags['delete-branch'] })
    },
    'pr link': () => h.prLink(number(target, 'PR number'), number(single(flags, 'issue', true), '--issue')),
  }
  const fn = route[key]
  const result = await fn()
  process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`)
}

main(process.argv.slice(2)).catch((error) => {
  const code = error instanceof HostError ? error.code : 1
  process.stderr.write(`${JSON.stringify({ error: error.message, code })}\n`)
  process.exit(code)
})
