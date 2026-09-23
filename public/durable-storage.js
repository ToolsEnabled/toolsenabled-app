/* THE STORE THE REST OF THIS APPLICATION TALKS TO.
 *
 * Every settings module in src/ calls localStorage, and localStorage is keyed
 * to the origin. The origin here is http://127.0.0.1:<port> with <port> chosen
 * by a scan of 4601-4609 at launch, so relaunching while the old port is held
 * moved the whole application to an empty storage partition and looked exactly
 * like a factory reset. This file makes `localStorage` mean "the durable
 * settings file in userData" instead, so no port can partition it.
 *
 * WHY THE STORE MOVED INSTEAD OF FIFTEEN CALL SITES. Rewriting each module to
 * call a new API would have left the two states this codebase keeps getting
 * bitten by: some keys durable, some still origin-scoped, and no way to see
 * which from a call site. It would also miss every key added after the rewrite
 * -- the defect would simply regrow. Replacing the store fixes the whole class
 * at the boundary, and a module that has never heard of any of this is correct
 * by construction.
 *
 * WHY IT IS A CLASSIC SCRIPT IN THE HEAD. index.html reads the stored theme in
 * an inline script before first paint, deliberately, so that a black-theme user
 * does not get a white flash. That read happens before any module evaluates, so
 * a module-based install would be too late for the one read most visible to a
 * person. A classic script blocks and runs in document order, so this is
 * installed before the theme is read and before anything else exists.
 *
 * IN A PLAIN BROWSER THIS DOES NOTHING. `window.mcPrefs` is exposed only by the
 * desktop shell's preload. Under `vite dev` or `vite preview` there is no host
 * to be durable against, so the real localStorage is left exactly as it was --
 * the same rule window.mcSetup and window.mcAgent already follow.
 *
 * NAMED PROPERTY ACCESS IS NOT USED BY THIS APPLICATION. Real Storage lets you
 * write `localStorage.foo`. Nothing in src/ does -- every access goes through
 * getItem/setItem/removeItem -- and tools/test/durable-storage.test.mjs fails
 * if that ever stops being true.
 *
 * ENUMERATION HAD TO BE PROVIDED ANYWAY, BECAUSE IT WAS ALREADY ANSWERING.
 * This file used to be a plain object whose own ENUMERABLE properties were its
 * five methods and `length`, so a caller asking what was stored got
 *   Object.keys(localStorage)    -> ['getItem','setItem','removeItem','clear','key','length']
 *   Object.entries(localStorage) -> those names paired with the FUNCTIONS
 * confidently, with no error. On 2026-09-20 a probe took that as a backup of
 * the owner's settings, called clear(), and wrote the six pairs back: six
 * trees, 82 agent nodes and every preference went, and the record was left
 * holding keys literally named `getItem`, `clear` and `length`. Two shipped
 * tools read the store that way today -- tools/four-defects-drive.mjs:316 and
 * tools/home-activity-substance-qa.mjs:367.
 *
 * SO THE TRAPS BELOW IMPLEMENT WHAT A REAL Storage DOES, WHICH IS NOT "SHOW
 * EVERYTHING". Storage is a legacy platform object WITHOUT [LegacyOverrideBuiltIns],
 * so WebIDL's named property visibility algorithm hides any stored key whose
 * name the object or its prototype chain already carries: `getItem`, `length`,
 * `toString` and friends are NOT exposed as own properties, and the methods
 * keep winning `.` access. Such a key is reachable only through getItem(), and
 * it still counts in length and still appears in key(i) -- verified against
 * node --experimental-webstorage, which implements the same algorithm.
 *
 * That rule is the whole point on the owner's record, which holds all six junk
 * names as DATA: a store where `localStorage.getItem` stopped being a function
 * would take the application down on the next line. The cost is that such a
 * key cannot appear in Object.keys/entries, so its existence is said out loud
 * once at install instead of being left for a backup to come up short on.
 *
 * EVERY TRAP AGREES, so a snapshot taken any standard way is either right or
 * refuses out loud. ownKeys/length/key() report the same list; a key that is
 * exposed reads back through `.`, `in`, Object.entries, spread, JSON.stringify
 * and structuredClone as the same string getItem() returns; a write or a delete
 * aimed at a member name is refused with a TypeError rather than clobbering a
 * method or storing a value that the same expression could not read back.
 *
 * ONE DELIBERATE DEVIATION: the methods are non-enumerable own properties
 * rather than enumerable prototype ones, so `for (k in localStorage)` yields
 * only stored keys. A browser yields the six method names there too, and
 * a for-in backup on a browser therefore collects functions. Nothing in this
 * application uses for-in on the store, and collecting functions is the defect
 * this file exists to end.
 */
;(function installDurableStorage() {
  var bridge = window.mcPrefs
  if (!bridge || bridge.available !== true) return

  /* MIGRATION HAPPENS HERE, BEFORE THE GLOBAL IS REPLACED, AND IN THIS
     DOCUMENT.
     An install that predates this file has its settings in the browser
     partition for this origin, and this is the last moment they are reachable:
     `window.localStorage` is still the real one on the line below.

     It is done here rather than in the preload because the preload runs
     against the initial empty document, whose storage is NOT this origin's.
     Measured on the packaged upgrade path before this moved: a legacy install
     holding two real settings on 4601 was read as zero entries, and the origin
     was then marked as migrated -- stranding them for good. So the entries are
     read first, and the host is told to mark the origin ONLY once that read
     has actually succeeded. A read that throws leaves the origin unmarked, and
     a later launch tries again. */
  /* WHAT THE PERSON IS OWED IF THEIR SETTINGS DID NOT LOAD.
   *
   * The store beneath this preserves a settings file it cannot read instead of
   * replacing it. That stops the data loss and, on its own, nothing else: the
   * app still opens wearing none of the choices they made, which from where
   * they sit is exactly the silent factory reset it replaced. So the facts are
   * carried here and published, and src/settings-recovery-notice.js turns them
   * into a sentence on the screen.
   *
   * `preservedAt` ARRIVES LATE, ON PURPOSE. The unreadable file is only moved
   * when a write actually happens -- deliberately, because a file that was only
   * transiently unreadable is recovered intact by the next launch's retrying
   * read, and moving it eagerly would displace a record that was never damaged.
   * So at boot this is usually null and the notice says the file is still in
   * place; the first write returns the dated path and the notice updates.
   */
  var notice = {
    damaged: typeof bridge.damaged === 'string' ? bridge.damaged : null,
    file: typeof bridge.file === 'string' ? bridge.file : null,
    preservedAt: typeof bridge.preservedAt === 'string' ? bridge.preservedAt : null,
    // Publish refusals before throwing: settings callers may swallow the error.
    refused: null,
  }
  var refusalSequence = 0
  var listeners = []
  function readNotice() {
    return { damaged: notice.damaged, file: notice.file, preservedAt: notice.preservedAt, refused: notice.refused }
  }
  /* A listener that throws must not take the write down with it. The notice is
     an explanation; a broken explanation is not worth failing a save over. */
  function announce() {
    var snapshot = readNotice()
    for (var index = 0; index < listeners.length; index += 1) {
      try { listeners[index](snapshot) } catch (error) { /* a notice is not worth a throw */ }
    }
  }
  function learnFrom(result) {
    if (!result || typeof result.preservedAt !== 'string') return
    if (result.preservedAt === notice.preservedAt) return
    notice.preservedAt = result.preservedAt
    announce()
  }

  var initial = bridge.values || {}
  function reportDrainFailure(result) {
    learnFrom(result)
    notice.refused = {
      sequence: ++refusalSequence,
      code: result && result.error && result.error.code || 'MC_PREFS_DRAIN_FAILED',
      key: 'legacy settings and recovery', action: 'import',
      message: 'The legacy browser data could not be imported. The browser copy was kept. Recovery may be unavailable until the import succeeds.',
    }
    announce()
  }
  if (bridge.drainRequired === true) {
    var entries = null
    try {
      var native = window.localStorage
      entries = []
      for (var index = 0; index < native.length; index += 1) {
        var storedKey = native.key(index)
        if (typeof storedKey !== 'string') continue
        var storedValue = native.getItem(storedKey)
        if (typeof storedValue === 'string') entries.push([storedKey, storedValue])
      }
    } catch (error) { entries = null }
    if (entries) {
      var drained
      try { drained = bridge.drain(entries) }
      catch (error) { drained = { ok: false, error: { code: 'MC_PREFS_DRAIN_FAILED' } } }
      learnFrom(drained)
      if (drained && drained.ok && drained.values) initial = drained.values
      else if (!drained || !drained.ok) reportDrainFailure(drained)
    } else {
      reportDrainFailure({ ok: false, error: { code: 'MC_PREFS_DRAIN_READ_FAILED' } })
    }
  }

  var cache = new Map()
  for (var name in initial) {
    if (Object.prototype.hasOwnProperty.call(initial, name)) cache.set(name, String(initial[name]))
  }

  /* A failed write THROWS, exactly as the platform does when storage is full.
     Silently dropping it would put the app back in the world this fix exists to
     leave: a person changes a setting, nothing complains, and the choice is not
     there next time. Every call site in src/ already wraps storage in
     try/catch, so a throw is contained where the platform's would have been. */
  function demand(result, action, key) {
    /* The news travels on the result of the write that caused it, so it is
       collected before the success check -- a refusal to overwrite an
       unreadable record is exactly the case a person most needs explained, and
       reading the notice only on the happy path would drop it there. */
    learnFrom(result)
    if (result && result.ok === true) {
      // A different successful write does not save the previously refused change.
      if (notice.refused && notice.refused.key === String(key) && notice.refused.action === action) {
        notice.refused = null
        announce()
      }
      return
    }
    var reason = result && result.error && result.error.message
      ? result.error.message
      : 'the settings file could not be written'
    /* PUBLISHED BEFORE THE THROW, so the order cannot matter: a caller that
       catches and ignores has already been overtaken. */
    notice.refused = {
      sequence: ++refusalSequence,
      code: result && result.error && typeof result.error.code === 'string' ? result.error.code : 'MC_PREFS_WRITE_FAILED',
      key: String(key),
      action: action,
      message: reason,
    }
    announce()
    throw new Error('Could not ' + action + ' setting ' + JSON.stringify(key) + ': ' + reason)
  }

  function callBridge(operation, args) {
    try { return bridge[operation].apply(bridge, args) }
    catch (error) {
      return { ok: false, error: { code: 'MC_PREFS_WRITE_FAILED', message: 'The settings service could not be reached.' } }
    }
  }

  /* ---- WHICH SETTINGS FOLLOW THE PERSON, NOT THE COMPUTER ----
   *
   * Everything above this line is per DEVICE, keyed by the raw setting name, and
   * that is correct for a window position or a text size. Three things are not:
   * the appearance choice (`mc.theme`), the settings on the settings page
   * (`mc.set.*`), and the purchase selection (`mc.checkout.v1`) belong to WHOEVER
   * IS SIGNED IN. Before this, all three were written to the one device record,
   * last-writer-wins, so a second person on the same Windows login opened the app
   * wearing the first person's theme, settings and ticked purchase lines. His
   * name and card were already safe; these were not.
   *
   * WHEN SIGNED IN, an account-scoped key is:
   *   - held in `accountOverlay`, the only thing `getItem` consults for it, so a
   *     value the account never set reads as ABSENT rather than as the device
   *     value or the previous account's -- which is the whole no-leak property;
   *   - written to shell/product-account.cjs's per-account partition through
   *     `mcAccount.putSetting`, the authoritative store re-read on the next
   *     sign-in and the file that makes <userData>/accounts/<id>.json exist;
   *   - mirrored SYNCHRONOUSLY into this device record under a per-account key
   *     (`acct:<id>:<name>`), so a settings click is durable the instant it
   *     returns exactly as localStorage.setItem was, and the settings FILE itself
   *     is partitioned instead of holding one shared record.
   *
   * WHEN SIGNED OUT (or when the shell cannot say who is signed in) it falls
   * through to the device record, unchanged. FAIL CLOSED: anything other than a
   * well-formed "signed in as <32-hex id>" resolves to signed out, so an
   * unreadable account state can never route a write into another person's name.
   *
   * The account is asked ASYNCHRONOUSLY, so this store starts signed out and is
   * told who is signed in by `refreshAccount()` -- at launch (a relaunch can come
   * up already signed in) and whenever src/views/account.js pokes the hook below.
   */
  var ACCOUNT = window.mcAccount && typeof window.mcAccount.current === 'function' ? window.mcAccount : null
  var accountId = null
  var accountOverlay = new Map()
  var hydrateToken = 0
  var accountReady = !ACCOUNT

  function isAccountScoped(name) {
    return name === 'mc.theme' || name === 'mc.checkout.v1' || name.indexOf('mc.set.') === 0 || name.indexOf('mc.metrics.') === 0
  }
  function namespaced(id, name) { return 'acct:' + id + ':' + name }

  /* The authoritative per-account write. Asynchronous and best-effort: the
     synchronous device mirror above already made the value durable for this run,
     and a rejected invoke must not throw into a settings click. A `null` value
     removes the key, which is how a setting returned to its default clears. */
  function putToPartition(name, value) {
    if (!ACCOUNT || typeof ACCOUNT.putSetting !== 'function') return
    try { Promise.resolve(ACCOUNT.putSetting(name, value)).catch(function () {}) }
    catch (error) { /* the bridge went away; the device mirror already holds it */ }
  }

  /* The theme is painted once at load and only re-read on a click, so a change
     of account has to re-apply it or a person keeps the previous account's
     appearance until they touch the control. The settings page and the checkout
     re-read localStorage every time they mount, so they need no help here; the
     event lets a currently-mounted view refresh itself if it wants to. */
  function reapplyAfterAccountChange() {
    accountReady = true
    var raw = accountId !== null
      ? (accountOverlay.has('mc.theme') ? accountOverlay.get('mc.theme') : null)
      : (cache.has('mc.theme') ? cache.get('mc.theme') : null)
    var theme = ['tan', 'black', 'ember', 'cobalt'].indexOf(raw) !== -1 ? raw : 'white'
    try { window.document.documentElement.dataset.theme = theme } catch (error) { /* no DOM under test */ }
    try {
      if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('mc:account-storage-rehydrated', { detail: { theme: theme } }))
      }
    } catch (error) { /* nobody is listening */ }
  }

  async function refreshAccount() {
    if (!ACCOUNT) return
    accountReady = false
    try { window.dispatchEvent(new window.CustomEvent('mc:account-storage-changing')) } catch (error) { /* no DOM under test */ }
    var token = ++hydrateToken
    var id = null
    try {
      var current = await ACCOUNT.current()
      if (current && current.signedIn === true && current.account
          && typeof current.account.id === 'string' && /^[0-9a-f]{32}$/.test(current.account.id)) {
        id = current.account.id
      }
    } catch (error) { id = null } // fail closed: any unreadable state is signed out
    if (token !== hydrateToken) return // a newer change is already in flight
    if (id === null) {
      accountId = null
      accountOverlay = new Map()
      reapplyAfterAccountChange()
      return
    }
    /* Built from the authoritative partition first -- this is what carries a
       first account's adopted settings, which live only there -- then the device
       mirror wins for any key it also holds, so a putSetting that never landed is
       still covered by the synchronous write. */
    var overlay = new Map()
    try {
      var data = typeof ACCOUNT.data === 'function' ? await ACCOUNT.data() : null
      if (data && data.ok === true && Array.isArray(data.settingKeys) && typeof ACCOUNT.getSetting === 'function') {
        for (var i = 0; i < data.settingKeys.length; i += 1) {
          var key = data.settingKeys[i]
          if (typeof key !== 'string' || !isAccountScoped(key)) continue
          try {
            var got = await ACCOUNT.getSetting(key)
            if (got && got.ok === true && typeof got.value === 'string') overlay.set(key, got.value)
          } catch (error) { /* one unreadable key does not empty the account */ }
        }
      }
    } catch (error) { /* an unreadable partition falls through to the device mirror */ }
    if (token !== hydrateToken) return
    var prefix = 'acct:' + id + ':'
    cache.forEach(function (value, storedKey) {
      if (storedKey.indexOf(prefix) !== 0) return
      var bare = storedKey.slice(prefix.length)
      if (isAccountScoped(bare)) overlay.set(bare, value)
    })
    accountId = id
    accountOverlay = overlay
    reapplyAfterAccountChange()
  }

  var storage = {
    getItem: function getItem(key) {
      var name = String(key)
      if (accountId !== null && isAccountScoped(name)) {
        return accountOverlay.has(name) ? accountOverlay.get(name) : null
      }
      return cache.has(name) ? cache.get(name) : null
    },
    setItem: function setItem(key, value) {
      var name = String(key)
      var text = String(value)
      if (accountId !== null && isAccountScoped(name)) {
        var mirror = namespaced(accountId, name)
        demand(callBridge('write', [mirror, text]), 'save', name)
        cache.set(mirror, text)
        accountOverlay.set(name, text)
        putToPartition(name, text)
        return
      }
      // Fleet saves carry the page's prior whole-cell value. MAIN compares it
      // atomically before admission so a stale page cannot erase another slot.
      var writeArgs = [name, text]
      if (/^mc\.fleet\.trees\.v1:/.test(name)) writeArgs.push(cache.has(name) ? cache.get(name) : null)
      demand(callBridge('write', writeArgs), 'save', name)
      cache.set(name, text)
    },
    removeItem: function removeItem(key) {
      var name = String(key)
      if (accountId !== null && isAccountScoped(name)) {
        var mirror = namespaced(accountId, name)
        demand(callBridge('remove', [mirror]), 'remove', name)
        cache.delete(mirror)
        accountOverlay.delete(name)
        putToPartition(name, null)
        return
      }
      demand(callBridge('remove', [name]), 'remove', name)
      cache.delete(name)
    },
    clear: function clear() {
      demand(callBridge('clear', []), 'clear', '(all settings)')
      cache.clear()
    },
    key: function key(index) {
      var position = Number(index)
      if (!Number.isInteger(position) || position < 0) return null
      var keys = storedKeys()
      return position < keys.length ? keys[position] : null
    },
  }

  /* WHAT IS IN THE STORE, AS getItem WOULD ANSWER IT.
   *
   * Signed out that is the device record. Signed in it is the device record
   * MINUS the per-account mirrors (`acct:<id>:<name>`, which are storage
   * plumbing and not keys anybody set) and MINUS any account-scoped name still
   * left in the device record from before the split -- getItem reads those from
   * the overlay and would disagree with the list otherwise -- PLUS the overlay
   * itself. ONE list answers key(), length, ownKeys and every enumeration, so
   * those four cannot drift apart again. */
  function storedKeys() {
    if (accountId === null) return Array.from(cache.keys())
    var prefix = 'acct:' + accountId + ':'
    var names = []
    cache.forEach(function (value, storedKey) {
      if (storedKey.indexOf(prefix) === 0) return
      if (isAccountScoped(storedKey)) return
      names.push(storedKey)
    })
    accountOverlay.forEach(function (value, name) {
      if (names.indexOf(name) === -1) names.push(name)
    })
    return names
  }
  function isStored(name) {
    if (accountId === null) return cache.has(name)
    return storedKeys().indexOf(name) !== -1
  }

  /* Not enumerable, because they are not stored values; configurable, because
     the traps hide them and a proxy may only report a property absent when the
     target's own copy of it is configurable and the target is extensible. */
  var members = Object.keys(storage)
  for (var memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    Object.defineProperty(storage, members[memberIndex], {
      value: storage[members[memberIndex]], enumerable: false, writable: true, configurable: true,
    })
  }
  Object.defineProperty(storage, 'length', {
    get: function () { return accountId === null ? cache.size : storedKeys().length },
    enumerable: false,
    configurable: true,
  })

  /* THE NAMED PROPERTY VISIBILITY RULE, in one line: a name the object or its
     prototype chain already carries is never exposed as an own property. That
     covers the five methods, `length`, and everything Object.prototype brings
     -- `toString`, `constructor`, `__proto__` -- exactly as a browser does. */
  function isMember(property) { return property in storage }

  function ownDescriptor(property) {
    return { value: storage.getItem(property), writable: true, enumerable: true, configurable: true }
  }

  var exposed = new Proxy(storage, {
    ownKeys: function () { return storedKeys() },
    getOwnPropertyDescriptor: function (target, property) {
      if (typeof property !== 'string') return Reflect.getOwnPropertyDescriptor(target, property)
      if (isMember(property) || !isStored(property)) return undefined
      return ownDescriptor(property)
    },
    has: function (target, property) {
      if (typeof property !== 'string') return Reflect.has(target, property)
      return isMember(property) || isStored(property)
    },
    get: function (target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      if (isMember(property)) return Reflect.get(target, property, receiver)
      // Absent is `undefined` here and `null` from getItem(), as on the platform.
      return isStored(property) ? storage.getItem(property) : undefined
    },
    /* A NAMED WRITE IS DURABLE OR IT IS A TypeError -- never a property quietly
       parked on this object that no later launch would find. A browser stores
       `localStorage.getItem = 'x'` under that name and then cannot read it back
       through `localStorage.getItem`; refusing is the loud version of the same
       answer, and it is the version that cannot cost the renderer its method. */
    /* A SYMBOL IS NOT A NAMED PROPERTY, so it is none of this rule's business:
       it goes to the target exactly as it did before this file grew a Proxy,
       and exactly as `get`, `has` and `getOwnPropertyDescriptor` above already
       send one. Refusing it would make `store[Symbol(...)] = x` -- how a
       library tags an object it did not write -- throw a TypeError in a
       renderer, for a rule that is only ever about names. */
    set: function (target, property, value) {
      if (typeof property !== 'string') return Reflect.set(target, property, value)
      if (isMember(property)) return false
      storage.setItem(property, value)
      return true
    },
    defineProperty: function (target, property, descriptor) {
      if (typeof property !== 'string') return Reflect.defineProperty(target, property, descriptor)
      if (isMember(property)) return false
      if (!('value' in descriptor) || descriptor.get || descriptor.set) return false
      /* REFUSED BEFORE THE WRITE, NOT AFTER IT. A stored key is an ordinary,
         configurable cell; asking for a non-configurable one is a request this
         store cannot keep, and the Proxy specification turns a `true` answer to
         it into a TypeError -- which would leave the value already saved and the
         caller holding an exception. */
      if (descriptor.configurable === false) return false
      storage.setItem(property, descriptor.value)
      return true
    },
    /* `delete localStorage.x` removes the stored key, as the platform's named
       property deleter does. A member name is refused rather than deleted: on
       the platform it would remove the shadowed stored key, here it would take
       the method with it, and removeItem('getItem') already does that job. */
    deleteProperty: function (target, property) {
      if (typeof property !== 'string') return Reflect.deleteProperty(target, property)
      if (isMember(property)) return false
      if (isStored(property)) storage.removeItem(property)
      return true
    },
    // A real Storage refuses this too; letting it through would make every
    // hidden member name an invariant violation instead of a hidden key.
    preventExtensions: function () { return false },
  })

  /* SAID ONCE, BECAUSE THE ONLY OTHER WAY TO LEARN IT IS A BACKUP THAT CAME UP
     SHORT. These keys count in length and appear in key(i), so the documented
     Storage walk still collects them; Object.keys/entries cannot see them. */
  var shadowed = storedKeys().filter(isMember)
  if (shadowed.length > 0) {
    try {
      window.console.warn('ToolsEnabled settings: ' + shadowed.length + ' stored key(s) are named after Storage members ('
        + shadowed.join(', ') + '), so Object.keys/Object.entries cannot see them, exactly as in a browser.'
        + ' Read them with localStorage.getItem(name) and remove them with localStorage.removeItem(name).')
    } catch (error) { /* no console under test */ }
  }

  /* `configurable: true` so that a future owner of this file can replace the
     store again without a reload being the only way out. It is not writable:
     an accidental assignment to window.localStorage elsewhere should fail
     loudly rather than quietly restore the origin-scoped store and resurrect
     the defect. */
  Object.defineProperty(window, 'localStorage', {
    value: exposed,
    configurable: true,
    writable: false,
  })

  /* EXPOSED SEPARATELY FROM localStorage, because it is not storage. A module
     that wants to explain the state of the settings file asks here;
     src/settings-recovery-notice.js is the only caller, and in a plain browser
     this global is absent along with the rest of the shell -- so that module
     renders nothing rather than guessing. */
  Object.defineProperty(window, 'mcPrefsNotice', {
    value: Object.freeze({
      read: readNotice,
      reportRecoveryWrite: function reportRecoveryWrite(nodeId, result) {
        var key = 'Recovery checkpoint for ' + String(nodeId)
        if (result && result.ok === true) {
          if (notice.refused && notice.refused.key === key) { notice.refused = null; announce() }
          return
        }
        notice.refused = {
          sequence: ++refusalSequence, category: 'recovery', key: key, action: 'save',
          code: result && result.error && result.error.code || 'RECOVERY_WRITE_FAILED',
        }
        announce()
      },
      subscribe: function subscribe(listener) {
        if (typeof listener !== 'function') return function () {}
        listeners.push(listener)
        return function unsubscribe() {
          var at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    }),
    configurable: true,
    writable: false,
  })

  /* THE HOOK THE SIGN-IN SCREEN POKES. src/views/account.js calls this after a
     sign-in, sign-out, create, or password change, so the account overlay and
     the theme follow who is signed in without a reload. In a plain browser
     mcAccount is absent, this stays inert, and localStorage is per device as it
     always was. */
  Object.defineProperty(window, 'mcDurableStorage', {
    value: Object.freeze({
      refreshFleet: function (keys) {
        var refused = function () { return { ok: false, code: 'MC_SAVED_TREE_CACHE_REFRESH_REFUSED',
          reason: 'The saved repair completed, but this window could not read the updated trees. Existing words and sessions were kept.' } }
        if (!Array.isArray(keys) || keys.length > 64 || new Set(keys).size !== keys.length
            || keys.some(function (key) { return typeof key !== 'string' || !/^mc\.fleet\.trees\.v1:[^\u0000-\u001f\u007f]{1,180}$/.test(key) })) return refused()
        var changes = []
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i], answer
          try { answer = bridge.read(key) } catch (error) { return refused() }
          if (!answer || answer.ok !== true || typeof answer.value !== 'string') return refused()
          changes.push({ key: key, before: cache.has(key) ? cache.get(key) : null, after: answer.value })
        }
        // All reads must succeed before changing any cached cell; never write
        // the old launch cache back over the native repair.
        changes.forEach(function (change) { cache.set(change.key, change.after) })
        return { ok: true, changes: changes }
      },
      get accountReady() { return accountReady },
      onAccountChanged: function () { try { refreshAccount() } catch (error) { /* inert without a shell */ } },
    }),
    configurable: true,
    writable: false,
  })

  /* A relaunch can come up already signed in -- the session persists -- so the
     overlay is hydrated once at start rather than only on the next sign-in. */
  if (ACCOUNT) { try { refreshAccount() } catch (error) { /* inert without a shell */ } }
})()
