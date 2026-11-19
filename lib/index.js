/**
 * dsh-autoconsent — compiled host module (v1.1.0).
 *
 * Self-contained ESM build: the policy engine, the shadow-snapshot store and
 * the DeepSeek Harness wiring are merged into this single file, so the release
 * package carries no extra runtime modules.
 *
 * Generated from lib/policy.js + lib/snapshots.js + lib/app.js.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

//#region policy engine
/**
 * AutoConsent — pure policy engine.
 *
 * No DSH imports and no I/O: everything here is a deterministic function of
 * its inputs so it can be unit-tested in plain Node (`test/sim.mjs`).
 *
 * The engine answers one question per tool call: allow it silently, force a
 * human decision, or deny it outright. Denial is reserved for the two rules
 * that must outrank the global auto-approve switch (contract + blacklist) and
 * for an explicit "deny" subagent policy.
 */

/** Categories a tool name can fall into. */
const CATEGORY_ORDER = ['file', 'shell', 'network', 'clipboard', 'plugin', 'other']

const CATEGORY_LABELS = {
  file: '文件读写',
  shell: 'Shell 命令',
  network: '网络请求',
  clipboard: '剪贴板',
  plugin: '插件调用、内核操作',
  other: '其他工具调用',
}

/**
 * Decision precedence, highest first. Mirrors {@link decide} exactly and is
 * surfaced in the panel so the rule is visible where it applies.
 */
const DECISION_PRIORITY = [
  { key: 'blacklist', label: '高危黑名单', note: '命中即拒绝，始终生效' },
  { key: 'contract', label: '任务契约', note: '越界即拒绝，始终生效' },
  { key: 'quota', label: '资源配额', note: '耗尽后该分类强制人工审批' },
  { key: 'category', label: '分组开关', note: '关闭的分类强制人工审批' },
  { key: 'master', label: '一键自动放行', note: '以上规则通过后才轮到这里' },
]

/** Default tool → category table. Unknown tools fall into `other`. */
const DEFAULT_TOOL_CATEGORIES = {
  write: 'file',
  edit: 'file',
  read: 'file',
  read_image: 'file',
  glob: 'file',
  grep: 'file',
  lsp: 'file',
  pwsh: 'shell',
  bash: 'shell',
  job_list: 'shell',
  job_output: 'shell',
  job_kill: 'shell',
  web_fetch: 'network',
  web_search: 'network',
  plugin_manager: 'plugin',
  cordis_define: 'plugin',
  cordis_run: 'plugin',
  cordis_undefine: 'plugin',
  cordis_stop: 'plugin',
  cordis_inspect_list: 'plugin',
  cordis_inspect_query: 'plugin',
}

/** Tools whose effect is a permanent mutation (only these consume file quota). */
const MUTATING_TOOLS = new Set(['write', 'edit'])

/** Tools that reach outside the machine. */
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])

/**
 * Built-in high-risk blacklist. Short command words (`rm`, `sudo`, `dd`) are
 * matched on word boundaries so `confirm` or `address` never trip them; phrases
 * fall back to plain substring matching.
 */
const DEFAULT_BLACKLIST = [
  // 高危 shell 命令
  'rm',
  'sudo',
  'dd',
  'chmod 777',
  'chmod -R 777',
  'chmod 4755',
  // 强制删除
  'rm -rf',
  'rm -fr',
  'rmdir /s',
  'rd /s',
  'del /f',
  'del /s',
  'Remove-Item -Recurse -Force',
  // 磁盘 / 系统
  'format c:',
  'format /q',
  'mkfs',
  'dd if=',
  'diskpart',
  'cipher /w',
  'shutdown /s',
  'shutdown /r',
  'takeown /f c:\\windows',
  'icacls c:\\ /grant',
  // 不可逆的版本 / 数据操作
  'git push --force',
  'git push -f',
  'git reset --hard origin',
  'drop database',
  'truncate table',
  ':(){:|:&};:',
]

/** Preset templates. Every field is a partial settings object. */
const TEMPLATES = {
  solo: {
    label: '个人开发',
    description: '全部类目自动放行，配额宽松，不做在场降权。',
    settings: {
      categories: { file: true, shell: true, network: true, clipboard: true, plugin: true, other: true },
      quotas: { file: 200, shell: 100, network: 100, clipboard: 50, plugin: 20, other: 200 },
      presenceEnabled: false,
      subagentPolicy: 'isolate',
      planCheck: false,
      contractEnabled: false,
    },
  },
  audit: {
    label: '严格审计',
    description: '一律人工确认，契约与自述校验强制开启，子 Agent 禁止自动放行。',
    settings: {
      autoEnable: false,
      categories: { file: false, shell: false, network: false, clipboard: false, plugin: false, other: false },
      quotas: { file: 0, shell: 0, network: 0, clipboard: 0, plugin: 0, other: 0 },
      presenceEnabled: true,
      subagentPolicy: 'deny',
      planCheck: true,
      contractEnabled: false,
    },
  },
  intern: {
    label: '实习生权限',
    description: '只自动放行工作区内的文件修改，Shell 与网络必须人工确认。',
    settings: {
      categories: { file: true, shell: false, network: false, clipboard: false, plugin: false, other: false },
      quotas: { file: 30, shell: 0, network: 0, clipboard: 0, plugin: 0, other: 0 },
      presenceEnabled: true,
      subagentPolicy: 'deny',
      planCheck: true,
      contractEnabled: false,
    },
  },
}

const PATHISH = /(?:[A-Za-z]:[\\/][^\s'"`]+|(?:\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+|[\w.@-]+\.(?:[A-Za-z0-9]{1,8}))/g

/** Normalize a path for prefix comparison: forward slashes, lowercase drive. */
function normalizePath (value) {
  if (typeof value !== 'string') return ''
  let text = value.trim().replace(/^["'`]|["'`]$/g, '')
  text = text.replace(/\\/g, '/')
  text = text.replace(/\/{2,}/g, '/')
  return text
}

/** Pull path-like tokens out of free text (a goal, a justification, a command). */
function extractPaths (text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  const matches = text.match(PATHISH) || []
  for (const raw of matches) {
    const value = normalizePath(raw)
    if (value.length < 3) continue
    if (/^[a-z]+:\/\//i.test(value)) continue
    found.add(value)
  }
  return [...found]
}

/** Every tool-name-shaped token in a free-text goal. */
function extractKeywords (text) {
  if (typeof text !== 'string') return []
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || []
  return [...new Set(words)]
}

/**
 * Derive a constraint contract from a free-text goal.
 *
 * This is a deterministic lexical derivation — it is *not* an LLM call. It
 * collects the paths the goal names, the extensions those paths imply, and
 * read-only phrasing, then the contract check refuses mutations that fall
 * outside that footprint.
 */
function deriveContract (goal, options = {}) {
  const text = typeof goal === 'string' ? goal : ''
  const paths = extractPaths(text)
  const exts = new Set()
  // Concrete paths win: an extension rule would widen the contract far past the
  // named file, so only derive extensions when the goal names no path at all.
  if (paths.length === 0) {
    for (const match of text.matchAll(/\.([A-Za-z0-9]{1,8})\b/g)) exts.add(match[1].toLowerCase())
  }
  // A directory-looking token also allows everything below it.
  const dirs = paths.filter((path) => !/\.[A-Za-z0-9]{1,8}$/.test(path.split('/').pop() || ''))
  const readOnly = /(只读|仅读取|不要修改|不修改|不改动|read[- ]?only|do not (?:modify|change|edit)|without (?:making )?(?:any )?changes)/i.test(text)
  return {
    goal: text,
    createdAt: Date.now(),
    allowPaths: [...new Set([...dirs, ...paths])],
    allowExts: [...exts],
    readOnly,
    maxMutations: Number(options.maxMutations) > 0 ? Number(options.maxMutations) : 0,
    notes: buildContractNotes(paths, exts, readOnly),
  }
}

function buildContractNotes (paths, exts, readOnly) {
  const notes = []
  if (paths.length) notes.push(`允许的路径线索：${paths.slice(0, 8).join('、')}${paths.length > 8 ? ' …' : ''}`)
  if (exts.size) notes.push(`允许的文件类型：${[...exts].join('、')}`)
  if (readOnly) notes.push('目标声明为只读：任何写操作都会被拦截')
  if (!paths.length && !exts.size && !readOnly) notes.push('目标里没有可识别的路径，契约退化为“只拦截只读声明”')
  return notes
}

/**
 * Absolute Windows/POSIX filesystem paths that start a token.
 *
 * The leading delimiter matters: it keeps `http://host/x` (where `/x` follows
 * a colon) from being read as a filesystem path.
 */
const ABSOLUTE_PATH = /(?:^|[\s"'=(@,])((?:[A-Za-z]:[\\/][^\s'"`|<>;]*|\/(?:[^\s'"`|<>:;/]+\/)*[^\s'"`|<>:;/]+))/g

/**
 * Paths named inside a shell command.
 *
 * Shell text is not parseable by regex, so only unambiguous absolute paths are
 * considered: URLs, relative file names and flags are all ignored. That keeps
 * `curl https://host/api/x` or `node build.js` from tripping the contract while
 * `Remove-Item C:\Users\…\x` still does.
 */
function extractAbsolutePaths (text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  for (const match of text.matchAll(ABSOLUTE_PATH)) {
    const raw = match[1]
    if (!raw || raw.includes('://')) continue
    const value = normalizePath(raw)
    if (value.length < 4) continue
    found.add(value)
  }
  return [...found]
}

/** True when `path` is inside (or equal to) one of the contract's path clues. */
function pathAllowedByContract (contract, path) {
  if (!contract) return true
  const target = normalizePath(path).toLowerCase()
  if (!target) return true
  const allow = (contract.allowPaths || []).map((entry) => normalizePath(entry).toLowerCase()).filter(Boolean)
  const exts = (contract.allowExts || []).map((value) => String(value).toLowerCase()).filter(Boolean)
  if (allow.length === 0) {
    if (exts.length === 0) return true
    const ext = target.match(/\.([a-z0-9]{1,8})$/)
    return Boolean(ext && exts.includes(ext[1]))
  }
  for (const entry of allow) {
    if (target === entry) return true
    if (target.startsWith(entry.endsWith('/') ? entry : entry + '/')) return true
    const base = entry.split('/').pop()
    if (base && base !== entry && target.endsWith('/' + base)) return true
  }
  return false
}

/** Case-insensitive match of any rule against the haystack, boundary-aware. */
function matchRules (rules, haystacks) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const text = haystacks.filter(Boolean).join('\n').toLowerCase()
  if (!text) return null
  for (const rule of rules) {
    const value = String(rule || '').trim()
    if (value.length < 2) continue
    const lower = value.toLowerCase()
    // A bare command word must be its own token: `rm` blocks `rm -rf` but not
    // `confirm`, `sudo` blocks `sudo apt` but not `pseudo`.
    if (/^[a-z][a-z0-9._-]*$/.test(lower) && lower.length <= 8) {
      const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`).test(text)) return rule
      continue
    }
    if (text.includes(lower)) return rule
  }
  return null
}

const READ_ONLY_CLAIM = /(只读|仅读取|不要修改|不修改|不改动|不做任何修改|read[- ]?only|do not (?:modify|change|edit)|without (?:making )?(?:any )?changes)/i
const MUTATING_CLAIM = /(修改|写入|重写|新建|创建|删除|替换|重构|edit|write|rewrite|create|delete|replace|refactor|patch)/i

/**
 * Compare the agent's own words with the action it is actually about to take.
 *
 * Two checks, both deliberately narrow so they only fire on a clear
 * contradiction:
 *  1. a read-only claim immediately followed by a mutating call;
 *  2. a justification that names a different target than the call touches.
 */
function planVerdict ({ toolName, category, args, declaredText, justification }) {
  const target = callTarget(toolName, args)
  if (category === 'file' && MUTATING_TOOLS.has(toolName)) {
    if (declaredText && READ_ONLY_CLAIM.test(declaredText) && !MUTATING_CLAIM.test(declaredText)) {
      return '自述声明为只读，但本次工具调用会修改文件'
    }
    if (justification && READ_ONLY_CLAIM.test(justification)) {
      return '调用理由声明不需要修改，但本次工具调用会修改文件'
    }
  }
  if (category === 'shell' && declaredText && READ_ONLY_CLAIM.test(declaredText) && !MUTATING_CLAIM.test(declaredText)) {
    const command = String((args && (args.command || args.script)) || '')
    if (command && looksMutating(command)) {
      return '自述声明为只读，但本次 Shell 命令可能修改环境'
    }
  }
  if (justification && target) {
    const named = extractPaths(justification)
    if (named.length > 0) {
      const targetNorm = normalizePath(target).toLowerCase()
      const same = named.some((path) => {
        const value = normalizePath(path).toLowerCase()
        return targetNorm === value || targetNorm.endsWith('/' + value) || value.endsWith('/' + targetNorm)
      })
      if (!same) return '调用理由里写明的路径与本次实际操作的目标不一致'
    }
  }
  return null
}

/** The primary path/command a tool call operates on. */
function callTarget (toolName, args) {
  if (!args || typeof args !== 'object') return ''
  const direct = args.file_path || args.path || args.target || args.filePath || ''
  if (typeof direct === 'string' && direct) return direct
  if (toolName === 'pwsh' || toolName === 'bash') {
    return typeof args.command === 'string' ? args.command : ''
  }
  if (toolName === 'web_fetch') return typeof args.url === 'string' ? args.url : ''
  if (toolName === 'web_search') return Array.isArray(args.queries) ? args.queries.join(' ') : ''
  return ''
}

/** Short human-readable summary of one call for the preview/log surface. */
function callSummary (toolName, args) {
  const target = callTarget(toolName, args)
  if (!target) return String(toolName)
  const trimmed = target.length > 160 ? target.slice(0, 157) + '…' : target
  return `${toolName} · ${trimmed}`
}

/** Contract verdict: null means acceptable, a string means "block with reason". */
function contractVerdict (contract, { toolName, category, args }) {
  if (!contract || !contract.enabled) return null
  const target = callTarget(toolName, args)
  if (contract.readOnly && (MUTATING_TOOLS.has(toolName) || (category === 'shell' && target && looksMutating(target)))) {
    return '任务目标声明为只读，本次调用会修改环境'
  }
  if (category === 'file' && MUTATING_TOOLS.has(toolName) && target) {
    if (!pathAllowedByContract(contract, target)) {
      return `动作目标 "${target}" 不在本次任务契约的允许范围内`
    }
  }
  if (category === 'shell' && target) {
    const mutated = looksMutating(target)
    if (mutated) {
      const reachable = contract.allowPaths || []
      if (reachable.length > 0) {
        const touched = extractAbsolutePaths(target)
        if (touched.length > 0) {
          const outside = touched.filter((path) => !pathAllowedByContract(contract, path))
          if (outside.length > 0) return `Shell 命令触及契约范围之外的路径 "${outside[0]}"`
        }
      }
      if (contract.readOnly) return '任务目标声明为只读，本次 Shell 命令可能修改环境'
    }
  }
  return null
}

const READ_ONLY_COMMAND = /(^|[\s;&|(])(dir|ls|cat|type|get-content|get-childitem|get-item|test-path|select-string|where|findstr|rg|grep|head|tail|wc|git status|git diff|git log|git show|node --version|npm ls|pnpm ls|echo|pwd|cd)\b/i

const MUTATING_COMMAND = /(^|[\s;&|(])(rm|del|erase|rmdir|rd|mv|move|cp|copy|mkdir|md|new-item|remove-item|set-content|add-content|out-file|rename-item|clear-content|npm i|npm install|pnpm add|pnpm install|pip install|git push|git commit|git checkout|git reset|git clean|git apply|curl|wget|invoke-webrequest|iwr|tar|unzip|expand-archive|start-process|schtasks|reg add|sc create)\b/i

/** True when the command can plausibly change the machine (conservative). */
function looksMutating (command) {
  const text = String(command || '')
  if (!text) return false
  if (/[>]{1,2}|\|\s*(?:set-content|out-file|tee)\b/i.test(text)) return true
  return MUTATING_COMMAND.test(text)
}

/** True only when the command is provably a read. */
function isReadOnlyCommand (command) {
  const text = String(command || '').trim()
  if (!text) return true
  if (looksMutating(text)) return false
  return READ_ONLY_COMMAND.test(text)
}

/** How many of this call's category may still be auto-approved. */
function quotaLeft (settings, usage, category) {
  const quota = Number(settings && settings.quotas && settings.quotas[category])
  if (!Number.isFinite(quota) || quota < 0) return Infinity
  const used = Number(usage && usage[category]) || 0
  return Math.max(0, quota - used)
}

/** Categories that consume quota when they mutate something. */
function consumesQuota (toolName, category) {
  if (MUTATING_TOOLS.has(toolName)) return true
  return category === 'shell' || category === 'network' || category === 'clipboard' || category === 'plugin'
}

/**
 * The single decision entry point.
 *
 * Precedence (highest first, see {@link DECISION_PRIORITY}):
 *   1. 高危黑名单   — always denies
 *   2. 任务契约     — always denies (with 自述校验 as a contract-adjacent guard)
 *   3. 资源配额     — downgrade to a human decision
 *   4. 分组开关     — downgrade to a human decision
 *   5. 一键自动放行 — only reached when everything above passed
 * Subagent policy and presence are additional downgrades evaluated with (4).
 *
 * @returns {{action: 'allow'|'manual'|'deny'|'pass', code: string, reason: string, tags: string[], alert?: boolean}}
 */
function decide (input) {
  const {
    settings,
    enabled,
    expired,
    session,
    call,
  } = input
  const tags = []
  const toolName = call.toolName
  const category = call.category
  const categoryLabel = CATEGORY_LABELS[category] || category

  if (expired) tags.push('expired')

  // 1. 高危黑名单：优先级最高，命中直接拒绝。
  const blackHit = matchRules(settings.blacklist, [call.target, call.summary, call.raw])
  if (blackHit) {
    return {
      action: 'deny',
      code: 'blacklist',
      reason: `命中高危黑名单规则「${blackHit}」`,
      tags: [...tags, 'blacklist'],
      alert: true,
    }
  }

  // 2. 任务契约：任务边界独立于开关，越界即拒绝。
  if (settings.contractEnabled && session && session.contract) {
    const violation = contractVerdict({ ...session.contract, enabled: true }, call)
    if (violation) {
      return { action: 'deny', code: 'contract', reason: violation, tags: [...tags, 'contract'] }
    }
  }
  if (settings.planCheck) {
    const violation = planVerdict(call)
    if (violation) {
      return { action: 'deny', code: 'plan', reason: violation, tags: [...tags, 'plan'] }
    }
  }

  // 3. 资源配额：耗尽后该分类强制人工审批，一键开关无法绕过。
  let downgrade = null
  if (consumesQuota(toolName, category)) {
    const left = quotaLeft(settings, session && session.usage, category)
    if (left <= 0) {
      downgrade = { code: 'quota', reason: `「${categoryLabel}」配额已用尽，切回人工审批` }
    }
  }

  // 4. 分组权限开关。
  if (!downgrade && !(settings.categories && settings.categories[category])) {
    downgrade = { code: 'category-off', reason: `「${categoryLabel}」分组未开启自动放行` }
  }

  // 5. 一键自动放行总开关：关闭时不干预原生审批流程。
  if (!enabled) {
    return { action: 'pass', code: 'disabled', reason: '一键自动放行未开启', tags }
  }

  // 6. 子 Agent 独立策略。
  if (call.isChild) {
    if (settings.subagentPolicy === 'deny') {
      return { action: 'deny', code: 'subagent', reason: '子 Agent 调用了被禁止自动放行的工具', tags: [...tags, 'subagent'] }
    }
    if (!downgrade && settings.subagentPolicy === 'isolate') {
      downgrade = { code: 'subagent-isolate', reason: '子 Agent 权限默认隔离，需要人工确认' }
    }
  }

  // 7. 在场感知降权。
  if (!downgrade && settings.presenceEnabled && input.userPresent && (settings.presenceRisk || []).includes(category)) {
    downgrade = { code: 'present', reason: '检测到你正在操作电脑，该类动作改为人工确认' }
  }

  if (downgrade) {
    return { action: 'manual', code: downgrade.code, reason: downgrade.reason, tags: [...tags, downgrade.code] }
  }

  return { action: 'allow', code: 'auto', reason: '命中自动放行规则', tags }
}

/** Decide what an approval request that we never saw at pre-execute time gets. */
function decideUnseenApproval (input) {
  const { settings, enabled, expired, call, session } = input
  if (expired) return { action: 'manual', code: 'expired', reason: '定时自动放行已到期', tags: ['expired'] }
  const blackHit = matchRules(settings.blacklist, [call.target, call.summary, call.raw])
  if (blackHit) {
    return { action: 'deny', code: 'blacklist', reason: `命中高危黑名单规则「${blackHit}」`, tags: ['blacklist'], alert: true }
  }
  if (!enabled) return { action: 'manual', code: 'disabled', reason: '一键自动放行未开启', tags: [] }
  if (consumesQuota(call.toolName, call.category) && quotaLeft(settings, session && session.usage, call.category) <= 0) {
    return { action: 'manual', code: 'quota', reason: '该分类配额已用尽', tags: ['quota'] }
  }
  const categoryOn = Boolean(settings.categories && settings.categories[call.category])
  if (!categoryOn) return { action: 'manual', code: 'category-off', reason: '该分组未开启自动放行', tags: [] }
  if (call.isChild && settings.subagentPolicy !== 'inherit') {
    return { action: 'manual', code: 'subagent-isolate', reason: '子 Agent 权限默认隔离', tags: ['subagent'] }
  }
  return { action: 'allow', code: 'auto', reason: '命中自动放行规则', tags: [] }
}

/** Default settings assembled from config + template. */
function baseSettings (config = {}) {
  const template = TEMPLATES[config.template] || TEMPLATES.solo
  const preset = template.settings
  const settings = {
    enabled: Boolean(config.autoEnable),
    expiresAt: null,
    template: config.template && TEMPLATES[config.template] ? config.template : 'solo',
    categories: { ...(preset.categories || {}), ...(config.categories || {}) },
    quotas: { ...(preset.quotas || {}), ...(config.quotas || {}) },
    blacklist: Array.isArray(config.blacklist) && config.blacklist.length ? config.blacklist : DEFAULT_BLACKLIST,
    contractEnabled: config.contractEnabled ?? preset.contractEnabled ?? false,
    planCheck: config.planCheck ?? preset.planCheck ?? false,
    presenceEnabled: config.presenceEnabled ?? preset.presenceEnabled ?? true,
    presenceWindowMs: Number(config.presenceWindowMs) > 0 ? Number(config.presenceWindowMs) : 90000,
    presenceRisk: Array.isArray(config.presenceRisk) && config.presenceRisk.length ? config.presenceRisk : ['shell', 'plugin'],
    subagentPolicy: ['inherit', 'isolate', 'deny'].includes(config.subagentPolicy)
      ? config.subagentPolicy
      : (preset.subagentPolicy || 'isolate'),
    snapshotEnabled: config.snapshots !== false,
    resetEachTurn: config.resetEachTurn !== false,
    showProbe: config.showProbe !== false,
  }
  return settings
}

/** Merge a template into the current settings (used by the one-click switch). */
function applyTemplate (settings, name) {
  const template = TEMPLATES[name]
  if (!template) return settings
  const preset = template.settings
  return {
    ...settings,
    template: name,
    enabled: preset.autoEnable === undefined ? settings.enabled : preset.autoEnable,
    categories: { ...settings.categories, ...preset.categories },
    quotas: { ...settings.quotas, ...preset.quotas },
    presenceEnabled: preset.presenceEnabled ?? settings.presenceEnabled,
    subagentPolicy: preset.subagentPolicy ?? settings.subagentPolicy,
    planCheck: preset.planCheck ?? settings.planCheck,
    contractEnabled: preset.contractEnabled ?? settings.contractEnabled,
  }
}

/** Classify a tool name into a category. */
function classify (toolName, overrides) {
  const table = overrides && typeof overrides === 'object' ? overrides : DEFAULT_TOOL_CATEGORIES
  if (Object.prototype.hasOwnProperty.call(table, toolName)) return table[toolName]
  if (Object.prototype.hasOwnProperty.call(DEFAULT_TOOL_CATEGORIES, toolName)) return DEFAULT_TOOL_CATEGORIES[toolName]
  return 'other'
}

/** Stable-ish chain hash for the exported audit bundle. */
function chainHash (previous, payload) {
  const text = String(previous || '') + '|' + JSON.stringify(payload)
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ code, 0x85ebca6b) + i) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
//#endregion
//#region shadow snapshots
/**
 * AutoConsent — shadow snapshots and lightweight diffs.
 *
 * Snapshots are taken *before* a mutating file call runs, so every auto-approved
 * change can be rolled back without Git. Only the tools that expose their own
 * target path and payload participate (`write` / `edit`); shell side effects are
 * recorded but explicitly marked as not reversible.
 */

/** Read a file, reporting absence instead of throwing. */
async function readTextSafe (filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    return { exists: true, text, error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, text: null, error: null }
    return { exists: false, text: null, error: String((error && error.message) || error) }
  }
}

/** Write a file, creating parent directories as needed. */
async function writeTextSafe (filePath, text) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, text, 'utf8')
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** Remove a file, treating absence as success. */
async function removeFileSafe (filePath) {
  try {
    await fs.unlink(filePath)
    return { ok: true, error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, error: null }
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** Apply the same replacement a `edit` tool call will apply. */
function applyEdit (before, oldString, newString, replaceAll) {
  if (typeof before !== 'string') return null
  if (typeof oldString !== 'string' || oldString === '') return null
  if (typeof newString !== 'string') return null
  if (replaceAll) return before.split(oldString).join(newString)
  const index = before.indexOf(oldString)
  if (index < 0) return null
  return before.slice(0, index) + newString + before.slice(index + oldString.length)
}

/**
 * Line diff through common-prefix / common-suffix trimming.
 *
 * Cheap and bounded: enough for a preview card, never a full Myers diff.
 */
function diffLines (before, after, limit = 24) {
  const left = typeof before === 'string' ? before.split(/\r?\n/) : []
  const right = typeof after === 'string' ? after.split(/\r?\n/) : []
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1
  let endLeft = left.length - 1
  let endRight = right.length - 1
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) {
    endLeft -= 1
    endRight -= 1
  }
  const removed = left.slice(start, endLeft + 1)
  const added = right.slice(start, endRight + 1)
  const lines = []
  const contextBefore = left.slice(Math.max(0, start - 2), start)
  for (const text of contextBefore) lines.push({ type: 'ctx', text })
  const budget = Math.max(4, limit)
  const head = Math.min(removed.length, Math.ceil(budget / 2))
  const tail = Math.min(added.length, Math.ceil(budget / 2))
  for (const text of removed.slice(0, head)) lines.push({ type: 'del', text })
  if (removed.length > head) lines.push({ type: 'meta', text: `… 删除 ${removed.length - head} 行` })
  for (const text of added.slice(0, tail)) lines.push({ type: 'add', text })
  if (added.length > tail) lines.push({ type: 'meta', text: `… 新增 ${added.length - tail} 行` })
  return {
    lines,
    added: added.length,
    removed: removed.length,
    truncated: removed.length > head || added.length > tail,
  }
}

/** Absolute path for a tool argument, resolved against the session cwd. */
function resolveTarget (filePath, cwd) {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    if (path.isAbsolute(filePath)) return path.normalize(filePath)
    if (typeof cwd === 'string' && cwd) return path.normalize(path.join(cwd, filePath))
    return path.resolve(filePath)
  } catch {
    return null
  }
}

let counter = 0

/**
 * Capture the pre-image of one mutating call.
 *
 * @returns a snapshot record, or `{ error }` when the file could not be read.
 */
async function captureSnapshot ({ sessionId, callId, tool, args, cwd }) {
  const rawPath = args && (args.file_path || args.path || args.filePath)
  const absolute = resolveTarget(rawPath, cwd)
  if (!absolute) return { error: '无法解析目标路径' }
  const before = await readTextSafe(absolute)
  if (before.error) return { error: before.error }
  let after = null
  if (tool === 'write') {
    after = typeof (args && args.content) === 'string' ? args.content : null
  } else if (tool === 'edit') {
    after = applyEdit(before.text, args && args.old_string, args && args.new_string, Boolean(args && args.replace_all))
  }
  const diff = after === null ? null : diffLines(before.text, after)
  counter += 1
  return {
    id: `${Date.now().toString(36)}-${counter.toString(36)}`,
    sessionId,
    callId,
    tool,
    path: absolute,
    existed: before.exists,
    before: before.text,
    after,
    diff,
    createdAt: Date.now(),
    rolledBackAt: null,
  }
}

/** Roll one snapshot back to its pre-image. */
async function rollbackSnapshot (record) {
  if (!record) return { ok: false, error: '找不到该快照' }
  if (!record.existed) {
    const removed = await removeFileSafe(record.path)
    return { ok: removed.ok, error: removed.error, mode: 'delete' }
  }
  const written = await writeTextSafe(record.path, record.before ?? '')
  return { ok: written.ok, error: written.error, mode: 'restore' }
}

/** Strip the payload before sending a snapshot to the browser. */
function publicSnapshot (record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    callId: record.callId,
    tool: record.tool,
    path: record.path,
    existed: record.existed,
    diff: record.diff,
    createdAt: record.createdAt,
    rolledBackAt: record.rolledBackAt,
    bytes: typeof record.before === 'string' ? record.before.length : 0,
  }
}
//#endregion
//#region harness wiring
/**
 * AutoConsent — Host half.
 *
 * Task-scoped consent for DeepSeek Harness: not "is this action dangerous?"
 * but "is this action something *this task* allowed?". The classic one-click
 * global auto-approve stays, and seven task-boundary capabilities sit around it:
 *
 *   1. goal contract        — a derived contract that blocks out-of-scope work
 *                             even while the global switch is on;
 *   2. resource quotas      — per-category budgets that fall back to a human
 *                             decision when exhausted;
 *   3. shadow snapshots     — pre-images of every file mutation, one-click
 *                             rollback, no Git required;
 *   4. presence downgrade   — while you are at the keyboard, medium-risk
 *                             categories ask again;
 *   5. plan/action check    — the agent's own words are compared with the call
 *                             it is about to make;
 *   6. subagent isolation   — child agents never inherit the parent's consent;
 *   7. live preview         — the browser renders the pending change surface.
 *
 * Wiring: `tools/pre-execute` (prepended) decides allow / ask / deny for every
 * call; `approval/request` (prepended) turns an "allow" into `allowed-once`
 * without ever showing the native prompt, and hands everything else to the
 * normal answerer chain.
 */

export const name = 'dsh-autoconsent'

/** The HTTP surface is the only hard dependency; everything else is optional. */
export const inject = ['webServer']

const VERSION = '1.1.0'
const ROUTE = '/dsh-auto-consent'
const HEADER = 'x-auto-consent'
const LOG_CAP = 400
const SNAPSHOT_CAP = 200

function num (value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function home () {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.dsh')
}

function normalizeConfig (raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const position = cfg.position && typeof cfg.position === 'object' ? cfg.position : {}
  return {
    autoEnable: cfg.autoEnable !== false,
    template: typeof cfg.template === 'string' ? cfg.template : 'solo',
    categories: cfg.categories && typeof cfg.categories === 'object' ? cfg.categories : undefined,
    quotas: cfg.quotas && typeof cfg.quotas === 'object' ? cfg.quotas : undefined,
    blacklist: Array.isArray(cfg.blacklist) ? cfg.blacklist : undefined,
    contractEnabled: typeof cfg.contractEnabled === 'boolean' ? cfg.contractEnabled : undefined,
    planCheck: typeof cfg.planCheck === 'boolean' ? cfg.planCheck : undefined,
    presenceEnabled: typeof cfg.presenceEnabled === 'boolean' ? cfg.presenceEnabled : undefined,
    presenceWindowMs: num(cfg.presenceWindowMs, 90000),
    presenceRisk: Array.isArray(cfg.presenceRisk) ? cfg.presenceRisk : undefined,
    subagentPolicy: cfg.subagentPolicy,
    snapshots: cfg.snapshots !== false,
    resetEachTurn: cfg.resetEachTurn !== false,
    showProbe: cfg.showProbe !== false,
    repoUrl: typeof cfg.repoUrl === 'string' ? cfg.repoUrl.trim() : 'https://github.com/deepseek-ai',
    top: clamp(num(position.top ?? cfg.top, 50), 0, 4000),
    right: clamp(num(position.right ?? cfg.right, 14), 0, 4000),
    pollSeconds: clamp(num(cfg.pollSeconds, 3), 1, 60),
    storageFile: typeof cfg.storageFile === 'string' && cfg.storageFile.trim()
      ? cfg.storageFile.trim()
      : path.join(home(), 'storages', 'auto-consent', 'settings.json'),
  }
}

/** Every string-ish argument except the payload bodies (they are not targets). */
function argsText (args) {
  if (!args || typeof args !== 'object') return ''
  const skip = new Set(['content', 'new_string', 'old_string', 'justification', 'description'])
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (skip.has(key)) continue
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) parts.push(value.filter((item) => typeof item === 'string').join(' '))
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value))
  }
  return parts.join(' ').slice(0, 800)
}

function sessionIdOf (agent) {
  if (!agent || typeof agent !== 'object') return null
  const candidates = [agent.id, agent.session && agent.session.id, agent.sessionId]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return null
}

const SUBAGENT_LABELS = { inherit: '继承父级', isolate: '隔离', deny: '禁止自动放行' }

/**
 * Human-readable rule sheet for one role template, shown as its hover preview
 * so the switch can be understood before it is applied.
 */
function templateRules (template) {
  const preset = (template && template.settings) || {}
  const rules = []
  const categories = preset.categories || {}
  const on = Object.entries(categories).filter(([, value]) => value).map(([key]) => CATEGORY_LABELS[key] || key)
  const off = Object.entries(categories).filter(([, value]) => !value).map(([key]) => CATEGORY_LABELS[key] || key)
  rules.push(on.length ? '自动放行：' + on.join(' / ') : '不自动放行任何分类')
  if (off.length) rules.push('强制人工：' + off.join(' / '))
  const quotas = preset.quotas || {}
  const quotaText = Object.entries(quotas)
    .map(([key, value]) => `${CATEGORY_LABELS[key] || key} ${value}`)
    .join(' / ')
  if (quotaText) rules.push('配额：' + quotaText)
  if (preset.autoEnable === false) rules.push('切换后自动关闭一键放行')
  rules.push('子 Agent：' + (SUBAGENT_LABELS[preset.subagentPolicy] || '隔离'))
  rules.push('在场降权：' + (preset.presenceEnabled ? '开' : '关'))
  rules.push('自述校验：' + (preset.planCheck ? '开' : '关'))
  return rules
}

function isChildSession (session) {
  if (!session || typeof session !== 'object') return false
  const header = session.header || {}
  return Boolean(header.parentSession) || header.origin === 'subagent' || Number(header.delegationDepth) > 0
}

/** Best-effort text of one assistant message. */
function assistantText (event) {
  const message = event && event.data && event.data.message
  const content = message && Array.isArray(message.content) ? message.content : []
  const chunks = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
  }
  return chunks.join('\n').trim()
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 512 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function apply (ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...args) => {
    try { ctx.logger?.info?.('[auto-consent]', ...args) } catch {}
  }

  const settings = baseSettings({
    autoEnable: config.autoEnable,
    template: config.template,
    categories: config.categories,
    quotas: config.quotas,
    blacklist: config.blacklist,
    contractEnabled: config.contractEnabled,
    planCheck: config.planCheck,
    presenceEnabled: config.presenceEnabled,
    presenceWindowMs: config.presenceWindowMs,
    presenceRisk: config.presenceRisk,
    subagentPolicy: config.subagentPolicy,
    snapshots: config.snapshots,
    resetEachTurn: config.resetEachTurn,
    showProbe: config.showProbe,
  })

  const state = {
    settings,
    lastInputAt: 0,
    currentSessionId: null,
    sessions: new Map(),
    pending: new Map(),
    globalLog: [],
    snapshots: [],
    chain: '00000000',
    lastDecision: null,
    lastAlert: null,
    persistTimer: null,
  }

  // ---- session bookkeeping ---------------------------------------------

  const sessionOf = (id, hints = {}) => {
    if (!id) return null
    let entry = state.sessions.get(id)
    if (!entry) {
      entry = {
        id,
        usage: Object.fromEntries(CATEGORY_ORDER.map((key) => [key, 0])),
        isChild: false,
        cwd: undefined,
        declaredText: '',
        contract: null,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        log: [],
        snapshots: [],
      }
      state.sessions.set(id, entry)
    }
    if (hints.isChild !== undefined) entry.isChild = Boolean(hints.isChild)
    if (hints.cwd !== undefined) entry.cwd = hints.cwd
    entry.lastSeen = Date.now()
    return entry
  }

  const rememberSession = (session) => {
    if (!session || typeof session !== 'object') return null
    const id = session.id
    const entry = sessionOf(id, { isChild: isChildSession(session), cwd: session.header && session.header.cwd })
    return entry
  }

  // ---- audit log --------------------------------------------------------

  const recordDecision = (entry, record) => {
    const payload = {
      at: record.at,
      sessionId: record.sessionId,
      tool: record.tool,
      category: record.category,
      action: record.action,
      code: record.code,
      reason: record.reason,
      target: String(record.target || '').slice(0, 240),
      snapshotId: record.snapshotId || null,
      alert: record.alert === true,
    }
    state.chain = chainHash(state.chain, payload)
    const item = { ...payload, chain: state.chain }
    state.globalLog.unshift(item)
    if (state.globalLog.length > LOG_CAP) state.globalLog.length = LOG_CAP
    if (entry) {
      entry.log.unshift(item)
      if (entry.log.length > LOG_CAP) entry.log.length = LOG_CAP
    }
    state.lastDecision = item
    if (item.alert) state.lastAlert = item
    return item
  }

  const bumpUsage = (entry, category) => {
    if (!entry || !category) return
    entry.usage[category] = (Number(entry.usage[category]) || 0) + 1
  }

  // ---- decision plumbing ------------------------------------------------

  const isExpired = () => Boolean(settings.expiresAt) && Date.now() > settings.expiresAt

  const userPresent = () => {
    if (!settings.presenceEnabled) return false
    if (!state.lastInputAt) return false
    return Date.now() - state.lastInputAt < settings.presenceWindowMs
  }

  const buildCall = ({ toolName, args, sessionId, entry, session }) => {
    const category = classify(toolName, config.categories)
    const declaredText = (entry && entry.declaredText) || ''
    return {
      toolName,
      category,
      args: args || {},
      target: callTarget(toolName, args),
      summary: callSummary(toolName, args),
      raw: argsText(args),
      declaredText,
      justification: (args && typeof args.justification === 'string' && args.justification) || '',
      isChild: Boolean((entry && entry.isChild) || isChildSession(session)),
      sessionId,
    }
  }

  const evaluate = (call) => {
    const entry = sessionOf(call.sessionId)
    const expired = isExpired()
    const decision = decide({
      settings,
      enabled: settings.enabled && !expired,
      expired,
      session: entry,
      call,
      now: Date.now(),
      userPresent: userPresent(),
    })
    return decision
  }

  const takeSnapshot = async (call, callId) => {
    if (!settings.snapshotEnabled) return null
    if (!MUTATING_TOOLS.has(call.toolName)) return null
    const entry = sessionOf(call.sessionId)
    try {
      const record = await captureSnapshot({
        sessionId: call.sessionId,
        callId,
        tool: call.toolName,
        args: call.args,
        cwd: (entry && entry.cwd) || undefined,
      })
      if (record.error) {
        log('snapshot skipped:', record.error)
        return null
      }
      state.snapshots.unshift(record)
      if (state.snapshots.length > SNAPSHOT_CAP) state.snapshots.length = SNAPSHOT_CAP
      if (entry) {
        entry.snapshots.unshift(record.id)
        if (entry.snapshots.length > 100) entry.snapshots.length = 100
      }
      return record
    } catch (error) {
      log('snapshot failed:', error && error.message)
      return null
    }
  }

  // ---- events -----------------------------------------------------------

  // Every tool call passes here first. This is where the task boundary lives.
  ctx.effect(() => {
    const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        // The dispatch payload is a ToolExecution: `name` is the wire tool name.
        const toolName = exec && (exec.name || exec.toolName)
        if (!exec || typeof toolName !== 'string') return next()
        const sessionId = sessionIdOf(exec.agent)
        if (!sessionId) return next()
        const entry = rememberSession(exec.agent && exec.agent.session)
        const call = buildCall({
          toolName,
          args: exec.arguments,
          sessionId,
          entry,
          session: exec.agent && exec.agent.session,
        })

        const decision = evaluate(call)

        if (decision.action === 'deny') {
          recordDecision(entry, {
            at: Date.now(),
            sessionId,
            tool: call.toolName,
            category: call.category,
            action: 'deny',
            code: decision.code,
            reason: decision.reason,
            target: call.target,
            alert: decision.alert === true,
          })
          return {
            kind: 'deny',
            reason: `[AutoConsent] ${decision.reason}`,
            info: { name: 'AutoConsent', code: 'AUTO_CONSENT_BLOCKED', reason: decision.reason },
          }
        }

        if (decision.action === 'manual') {
          if (exec.callId) state.pending.set(exec.callId, { action: 'manual', at: Date.now(), sessionId })
          recordDecision(entry, {
            at: Date.now(),
            sessionId,
            tool: call.toolName,
            category: call.category,
            action: 'manual',
            code: decision.code,
            reason: decision.reason,
            target: call.target,
          })
          return {
            kind: 'ask',
            reason: `AutoConsent · ${decision.reason}`,
            displayReason: {
              en: `AutoConsent: ${decision.reason}`,
              zh: `AutoConsent：${decision.reason}`,
            },
          }
        }

        if (decision.action === 'pass') {
          if (exec.callId) state.pending.delete(exec.callId)
          return next()
        }

        // allow
        const snapshot = await takeSnapshot(call, exec.callId)
        if (consumesQuota(call.toolName, call.category)) bumpUsage(entry, call.category)
        if (exec.callId) {
          state.pending.set(exec.callId, {
            action: 'allow',
            at: Date.now(),
            sessionId,
            snapshotId: snapshot ? snapshot.id : null,
            tool: call.toolName,
            category: call.category,
            target: call.target,
            summary: call.summary,
          })
          // Bound the pending table.
          if (state.pending.size > 500) {
            const cutoff = Date.now() - 10 * 60 * 1000
            for (const [id, value] of state.pending) if (value.at < cutoff) state.pending.delete(id)
          }
        }
        recordDecision(entry, {
          at: Date.now(),
          sessionId,
          tool: call.toolName,
          category: call.category,
          action: 'auto',
          code: decision.code,
          reason: decision.reason,
          target: call.target,
          snapshotId: snapshot ? snapshot.id : null,
        })
        return next()
      } catch (error) {
        log('pre-execute failed, failing open:', error && error.message)
        return next()
      }
    }, { prepend: true })
    return dispose
  })

  // The approval gate: only an "allow" verdict becomes an automatic grant.
  ctx.effect(() => {
    const dispose = ctx.on('approval/request', (req, next) => {
      try {
        const signal = req && req.signal
        if (signal && signal.aborted) return 'cancelled'
        const sessionId = sessionIdOf(req && req.agent)
        const entry = rememberSession(req && req.agent && req.agent.session)
        const callId = req && req.callId
        const seen = callId ? state.pending.get(callId) : null
        if (callId && state.pending.has(callId)) state.pending.delete(callId)

        let action = null
        let code = 'auto'
        let reason = ''
        let alert = false
        let category = (seen && seen.category) || null
        if (seen) {
          action = seen.action
          code = 'recorded-' + seen.action
          reason = seen.action === 'allow' ? '预执行阶段已判定放行' : '预执行阶段要求人工确认'
        } else {
          const call = buildCall({
            toolName: (req && req.toolName) || 'unknown',
            args: {},
            sessionId,
            entry,
            session: req && req.agent && req.agent.session,
          })
          call.summary = `${call.toolName}${req && req.reason ? ' · ' + String(req.reason).slice(0, 120) : ''}`
          call.raw = String((req && req.reason) || '')
          category = call.category
          const decision = decideUnseenApproval({
            settings,
            enabled: settings.enabled && !isExpired(),
            expired: isExpired(),
            call,
            session: entry,
          })
          action = decision.action
          code = decision.code
          reason = decision.reason
          alert = decision.alert === true
        }

        if (action === 'allow') {
          recordDecision(entry, {
            at: Date.now(),
            sessionId,
            tool: (seen && seen.tool) || (req && req.toolName) || 'unknown',
            category: category || 'other',
            action: 'granted',
            code,
            reason,
            target: (seen && seen.target) || '',
            snapshotId: (seen && seen.snapshotId) || null,
          })
          return 'allowed-once'
        }
        if (action === 'deny') {
          recordDecision(entry, {
            at: Date.now(),
            sessionId,
            tool: (req && req.toolName) || 'unknown',
            category: category || 'other',
            action: 'rejected',
            code,
            reason,
            target: (seen && seen.target) || '',
            alert,
          })
          return 'rejected'
        }
        // manual: let the native answerer chain (browser prompt) decide.
        return next()
      } catch (error) {
        log('approval gate failed, delegating:', error && error.message)
        return next()
      }
    }, { prepend: true })
    return dispose
  })

  // Track the agent's own narration and reset per-turn budgets.
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event) return
        const entry = rememberSession(session)
        if (!entry) return
        if (event.type === 'assistant/message') {
          const text = assistantText(event)
          if (text) entry.declaredText = text.slice(0, 4000)
        } else if (event.type === 'turn/end') {
          if (settings.resetEachTurn) {
            for (const key of Object.keys(entry.usage)) entry.usage[key] = 0
          }
        } else if (event.type === 'turn/start') {
          state.currentSessionId = session.id
        }
      } catch {}
    })
    return dispose
  })

  ctx.effect(() => {
    const dispose = ctx.on('api-session/activity', (sessionId) => {
      if (typeof sessionId === 'string' && sessionId) state.currentSessionId = sessionId
    })
    return dispose
  })

  ctx.effect(() => {
    const dispose = ctx.on('agent/created', (payload) => {
      const agent = payload && payload.agent
      if (!agent) return
      rememberSession(agent.session)
    })
    return dispose
  })

  // ---- persistence ------------------------------------------------------

  const persistedShape = () => ({
    version: 1,
    savedAt: Date.now(),
    settings: {
      enabled: settings.enabled,
      expiresAt: settings.expiresAt,
      template: settings.template,
      categories: settings.categories,
      quotas: settings.quotas,
      blacklist: settings.blacklist,
      contractEnabled: settings.contractEnabled,
      planCheck: settings.planCheck,
      presenceEnabled: settings.presenceEnabled,
      presenceWindowMs: settings.presenceWindowMs,
      subagentPolicy: settings.subagentPolicy,
      showProbe: settings.showProbe,
    },
  })

  const persistNow = async () => {
    try {
      await fs.mkdir(path.dirname(config.storageFile), { recursive: true })
      await fs.writeFile(config.storageFile, JSON.stringify(persistedShape(), null, 2), 'utf8')
    } catch (error) {
      log('persist failed:', error && error.message)
    }
  }

  const schedulePersist = () => {
    if (state.persistTimer) return
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null
      void persistNow()
    }, 800)
    state.persistTimer.unref?.()
  }

  const restore = async () => {
    try {
      const text = await fs.readFile(config.storageFile, 'utf8')
      const saved = JSON.parse(text)
      const incoming = saved && saved.settings
      if (incoming && typeof incoming === 'object') {
        if (typeof incoming.enabled === 'boolean') settings.enabled = incoming.enabled
        if (typeof incoming.expiresAt === 'number') settings.expiresAt = incoming.expiresAt
        if (typeof incoming.template === 'string' && TEMPLATES[incoming.template]) settings.template = incoming.template
        if (incoming.categories && typeof incoming.categories === 'object') settings.categories = { ...settings.categories, ...incoming.categories }
        if (incoming.quotas && typeof incoming.quotas === 'object') settings.quotas = { ...settings.quotas, ...incoming.quotas }
        if (Array.isArray(incoming.blacklist)) settings.blacklist = incoming.blacklist
        if (typeof incoming.contractEnabled === 'boolean') settings.contractEnabled = incoming.contractEnabled
        if (typeof incoming.planCheck === 'boolean') settings.planCheck = incoming.planCheck
        if (typeof incoming.presenceEnabled === 'boolean') settings.presenceEnabled = incoming.presenceEnabled
        if (typeof incoming.presenceWindowMs === 'number') settings.presenceWindowMs = incoming.presenceWindowMs
        if (['inherit', 'isolate', 'deny'].includes(incoming.subagentPolicy)) settings.subagentPolicy = incoming.subagentPolicy
        if (typeof incoming.showProbe === 'boolean') settings.showProbe = incoming.showProbe
        log('restored settings from', config.storageFile)
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') log('restore failed:', error && error.message)
    }
  }

  // ---- HTTP surface -----------------------------------------------------

  const currentEntry = () => {
    if (state.currentSessionId) {
      const entry = state.sessions.get(state.currentSessionId)
      if (entry) return entry
    }
    // Fall back to the most recently active session.
    let latest = null
    for (const entry of state.sessions.values()) {
      if (!latest || entry.lastSeen > latest.lastSeen) latest = entry
    }
    return latest
  }

  const snapshot = () => {
    const entry = currentEntry()
    const now = Date.now()
    const expired = isExpired()
    const auto = state.globalLog.filter((item) => item.action === 'granted').length
    const manual = state.globalLog.filter((item) => item.action === 'manual').length
    const denied = state.globalLog.filter((item) => item.action === 'deny' || item.action === 'rejected').length
    const sessionSnapshots = entry
      ? state.snapshots.filter((record) => record.sessionId === entry.id)
      : []
    return {
      ok: true,
      version: VERSION,
      rev: 'r4',
      now,
      enabled: settings.enabled && !expired,
      expiresAt: settings.expiresAt,
      remainingMs: settings.expiresAt ? Math.max(0, settings.expiresAt - now) : null,
      expired,
      settings: {
        template: settings.template,
        categories: settings.categories,
        quotas: settings.quotas,
        blacklist: settings.blacklist,
        blacklistCount: settings.blacklist.length,
        contractEnabled: settings.contractEnabled,
        planCheck: settings.planCheck,
        presenceEnabled: settings.presenceEnabled,
        presenceWindowMs: settings.presenceWindowMs,
        subagentPolicy: settings.subagentPolicy,
        resetEachTurn: settings.resetEachTurn,
        snapshotEnabled: settings.snapshotEnabled,
        showProbe: settings.showProbe,
        repoUrl: config.repoUrl,
      },
      session: entry
        ? {
            id: entry.id,
            isChild: entry.isChild,
            usage: entry.usage,
            quotaLeft: Object.fromEntries(CATEGORY_ORDER.map((key) => [key, quotaLeft(settings, entry.usage, key)])),
            contract: entry.contract,
            declaredText: entry.declaredText.slice(0, 600),
          }
        : null,
      presence: {
        lastInputAt: state.lastInputAt,
        present: userPresent(),
        windowMs: settings.presenceWindowMs,
      },
      stats: { auto, manual, denied, total: state.globalLog.length },
      log: state.globalLog.slice(0, 12),
      logAll: state.globalLog.slice(0, 120),
      snapshots: sessionSnapshots.slice(0, 8).map(publicSnapshot),
      templates: Object.entries(TEMPLATES).map(([id, template]) => ({
        id,
        label: template.label,
        description: template.description,
        rules: templateRules(template),
      })),
      categories: CATEGORY_ORDER.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
      priority: DECISION_PRIORITY,
      ui: { top: config.top, right: config.right, pollSeconds: config.pollSeconds },
      lastDecision: state.lastDecision,
      lastAlert: state.lastAlert,
    }
  }

  const auditBundle = () => ({
    plugin: 'auto-consent',
    version: VERSION,
    generatedAt: Date.now(),
    settings: snapshot().settings,
    contract: currentEntry() ? currentEntry().contract : null,
    decisions: state.globalLog.slice(0, 400),
    snapshots: state.snapshots.slice(0, 80).map(publicSnapshot),
    chainHead: state.chain,
  })

  const setEnabled = (value, minutes) => {
    settings.enabled = value === true
    if (!settings.enabled) {
      settings.expiresAt = null
    } else if (Number(minutes) > 0) {
      settings.expiresAt = Date.now() + Number(minutes) * 60 * 1000
    } else {
      // "On" without a window means on until you turn it off: an old expired
      // deadline must not survive the switch.
      settings.expiresAt = null
    }
    schedulePersist()
  }

  const applySettingsPatch = (patch, minutes) => {
    if (!patch || typeof patch !== 'object') return
    if (typeof patch.enabled === 'boolean') {
      setEnabled(patch.enabled, minutes)
    }
    if (typeof patch.template === 'string' && TEMPLATES[patch.template]) {
      Object.assign(settings, applyTemplate(settings, patch.template))
    }
    if (patch.categories && typeof patch.categories === 'object') {
      for (const key of CATEGORY_ORDER) {
        if (typeof patch.categories[key] === 'boolean') settings.categories[key] = patch.categories[key]
      }
    }
    if (patch.quotas && typeof patch.quotas === 'object') {
      for (const key of CATEGORY_ORDER) {
        const value = patch.quotas[key]
        if (value !== undefined && Number.isFinite(Number(value))) settings.quotas[key] = clamp(Number(value), 0, 100000)
      }
    }
    if (typeof patch.contractEnabled === 'boolean') settings.contractEnabled = patch.contractEnabled
    if (typeof patch.planCheck === 'boolean') settings.planCheck = patch.planCheck
    if (typeof patch.presenceEnabled === 'boolean') settings.presenceEnabled = patch.presenceEnabled
    if (typeof patch.presenceWindowMs === 'number') settings.presenceWindowMs = clamp(patch.presenceWindowMs, 5000, 3600000)
    if (['inherit', 'isolate', 'deny'].includes(patch.subagentPolicy)) settings.subagentPolicy = patch.subagentPolicy
    if (Array.isArray(patch.blacklist)) settings.blacklist = patch.blacklist.map((item) => String(item)).filter(Boolean).slice(0, 200)
    if (typeof patch.resetEachTurn === 'boolean') settings.resetEachTurn = patch.resetEachTurn
    if (typeof patch.showProbe === 'boolean') settings.showProbe = patch.showProbe
    if (typeof patch.expiresAt === 'number') settings.expiresAt = patch.expiresAt
    if (patch.expiresAt === null) settings.expiresAt = null
    schedulePersist()
  }

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const method = (req.method || 'GET').toUpperCase()
    const route = url.pathname
    if (!route.startsWith(ROUTE)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const action = route.slice(ROUTE.length).replace(/^\/+/, '')

    if (method === 'GET' || method === 'HEAD') {
      if (action === '' || action === 'state') {
        const body = JSON.stringify(snapshot())
        if (method === 'HEAD') {
          res.statusCode = 200
          res.end()
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
        return
      }
      if (action === 'audit') {
        sendJson(res, 200, auditBundle())
        return
      }
      res.statusCode = 404
      res.end('not found')
      return
    }

    if (method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST, HEAD')
      res.end('method not allowed')
      return
    }
    if (req.headers[HEADER] !== '1') {
      res.statusCode = 403
      res.end('missing ' + HEADER + ' header')
      return
    }

    const body = await readJsonBody(req)

    if (action === 'settings') {
      applySettingsPatch(body && body.patch ? body.patch : body, body && body.minutes)
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'toggle') {
      setEnabled(body && body.enabled === true, body && body.minutes)
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'activity') {
      state.lastInputAt = Date.now()
      sendJson(res, 200, { ok: true, present: true })
      return
    }
    if (action === 'contract') {
      const entry = currentEntry()
      if (!entry) {
        sendJson(res, 409, { ok: false, error: '没有活动会话，无法绑定任务契约' })
        return
      }
      if (body && body.clear === true) {
        entry.contract = null
        settings.contractEnabled = false
        schedulePersist()
        sendJson(res, 200, snapshot())
        return
      }
      const goal = typeof (body && body.goal) === 'string' ? body.goal.trim() : ''
      if (!goal) {
        sendJson(res, 400, { ok: false, error: 'goal 不能为空' })
        return
      }
      entry.contract = { ...deriveContract(goal, { maxMutations: body && body.maxMutations }), enabled: true }
      settings.contractEnabled = true
      schedulePersist()
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'rollback') {
      const id = body && body.id
      const sessionId = (body && body.sessionId) || (currentEntry() && currentEntry().id)
      const candidates = state.snapshots.filter((record) => {
        if (record.rolledBackAt) return false
        if (id) return record.id === id
        return record.sessionId === sessionId
      })
      const results = []
      for (const record of candidates.slice(0, 40)) {
        const outcome = await rollbackSnapshot(record)
        if (outcome.ok) record.rolledBackAt = Date.now()
        results.push({ id: record.id, path: record.path, ok: outcome.ok, mode: outcome.mode, error: outcome.error || null })
        if (!outcome.ok) break
      }
      sendJson(res, 200, { ok: results.every((item) => item.ok), results, state: snapshot() })
      return
    }
    if (action === 'reset-quotas') {
      const entry = currentEntry()
      if (entry) for (const key of Object.keys(entry.usage)) entry.usage[key] = 0
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'clear-log') {
      state.globalLog.length = 0
      for (const entry of state.sessions.values()) entry.log.length = 0
      sendJson(res, 200, snapshot())
      return
    }
    res.statusCode = 404
    res.end('not found')
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        void handle(req, res).catch((error) => {
          try {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          } catch {}
        })
      },
    })
    return dispose
  })

  // ---- lifecycle --------------------------------------------------------

  ctx.effect(() => {
    void restore()
    return () => {
      if (state.persistTimer) clearTimeout(state.persistTimer)
      void persistNow()
    }
  })

  log('ready', 'enabled=' + settings.enabled, 'template=' + settings.template, 'route=' + ROUTE)

  return {
    get settings () { return settings },
    snapshot,
  }
}

export { contractVerdict, deriveContract, planVerdict }
//#endregion
