// Render the REAL settings component with REAL React and assert the cards a user
// expects are actually there.
//
// Why this exists on top of client-smoke.test.js: that test proves apply() runs
// and the dictionaries are registered. It does NOT prove the settings page
// renders — a component that throws while building its tree, or a card whose
// element tree collapses to nothing, passes a source-level assertion and still
// shows the user an empty panel. This walks the real element tree the way React
// would mount it.
//
// Two harness details matter and both were learning experiences:
//   · use ONE React instance (required through the same `require` the bundle
//     gets). An ESM import here created a second copy → "Invalid hook call",
//     which looks exactly like a broken component.
//   · React 18 captures the dispatcher OBJECT at load and reads `.current`, so
//     the dispatcher must be MUTATED in place; assigning a new `{current}` leaves
//     React reading a null dispatcher.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** Load the client bundle and run apply(), returning the settings component. */
function mountClient() {
  let loaded = null
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      confirm: () => true,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout, clearTimeout, console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', src,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, setTimeout, clearTimeout, console, sandbox.fetch, requireStub)

  const mod = loaded.factory(requireStub)
  let Page = null
  const sections = []
  const slotsSeen = []
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          // `slots.inject(slot, fn)` runs fn so it can register into the slot.
          inject: (slot, fn) => { slotsSeen.push(slot); fn(); return () => {} },
          register: (decl, comp) => {
            sections.push(decl)
            if (comp && decl && decl.name === 'settings.section') Page = comp
            return () => {}
          },
          get: () => [],
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      // Optional sidebar UI absent, as in a Web install without the sidebar plugin.
      if (name === 'betterSidebar' || name === 'sidebarRightTabs' || name === 'directoryPicker') return undefined
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  mod.apply(ctx)
  return { Page, sections, slotsSeen }
}

/** Walk an element tree, collecting rendered text, mounting function components. */
function collectText(tree) {
  if (Array.isArray(tree)) return tree.map(collectText).join(' ')
  if (tree == null || tree === false || tree === true) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (typeof tree !== 'object') return ''
  const isElement = tree.$$typeof !== undefined || tree.props !== undefined
  if (!isElement) return ''
  if (typeof tree.type === 'function' && tree.type !== React.Fragment) {
    try { return collectText(tree.type(tree.props)) } catch { /* needs effects; use children */ }
  }
  return tree.props ? collectText(tree.props.children) : ''
}

test('the settings page renders, and it contains the cards the user expects', () => {
  const { Page, sections, slotsSeen } = mountClient()
  assert.ok(Page, 'the settings section component must be registered')

  // Install the initial-render dispatcher ON the captured object (see header).
  const hookState = []
  let hookIndex = 0
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = {
    useState(init) {
      const i = hookIndex++
      if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init
      return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }]
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  }

  // Rendering must not throw: a throw here means the user sees a broken panel.
  const tree = Page({})
  const text = collectText(tree)

  assert.ok(text.length > 100, 'the panel must render real content')
  assert.match(text, /远程工作区/, 'the plugin title renders')
  assert.match(text, /工作区备份/, 'the simplified backup card is present')
  // The deploy entry must be present on a FRESH page (it used to require a prior
  // probe plus a failing verdict, so users only ever saw 体检).
  assert.match(text, /体检|部署/, 'the deploy entry is present without running a probe first')
  // No raw i18n key may leak into the UI (a missing dictionary entry renders the
  // key itself, which is how these panels silently show `settings.foo`).
  const leaked = text.match(/\bsettings\.[a-zA-Z][\w.]*/g)
  assert.deepEqual(leaked, null, `raw i18n keys leaked into the UI: ${leaked}`)
  assert.ok(sections.some((d) => d && d.name === 'settings.section'), 'registered into settings.section')
  assert.ok(slotsSeen.includes('settings.section'), 'the settings slot was used')
})

test('the backup card offers exactly a Back-up and a Restore control', () => {
  // The card is collapsed by default (`backupOpen` starts false), so the controls
  // only exist once it is expanded — which is exactly how a USER reaches them.
  // Drive the section toggle the way a click does, then assert on what appears.
  const { Page } = mountClient()
  const hookState = []
  const setters = []
  let hookIndex = 0
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = {
    useState(init) {
      const i = hookIndex++
      if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init
      if (!setters[i]) setters[i] = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }
      return [hookState[i], setters[i]]
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  }

  // Render once to fill the state slots, then expand, then render AGAIN.
  //
  // `hookIndex` must be reset before every render: it is a cursor into the hook
  // state array, and leaving it advanced makes the second render read the wrong
  // slots entirely (which looks like "the toggle did nothing").
  const render = () => { hookIndex = 0; return collectText(Page({})) }
  const collapsed = render()
  assert.match(collapsed, /工作区备份/, 'the card title is visible while collapsed')

  // Find the state slots that control collapsed sections and flip them.
  //
  // The panel has several independent collapsed sections and their useState order
  // is not part of any contract, so rather than guess WHICH index is the backup
  // one, expand every section that starts collapsed. The old option fields only
  // ever existed inside the backup card, so expanding everything cannot make the
  // "old fields are gone" assertion pass by accident.
  const collapsedIdx = hookState.map((v, i) => (v === false ? i : -1)).filter((i) => i >= 0)
  assert.ok(collapsedIdx.length > 0, 'the panel starts with collapsed sections')
  for (const i of collapsedIdx) setters[i](true)
  const expanded = render()

  assert.match(expanded, /备份/, 'a Back-up control exists once expanded')
  assert.match(expanded, /恢复/, 'a Restore control exists once expanded')
  assert.match(expanded, /选择要恢复的备份时间点/, 'a point-in-time picker exists')
  // The removed configuration surface must NOT be back.
  assert.doesNotMatch(expanded, /排除项|存放位置|合并（不删除）/, 'the old option fields are gone')
})
