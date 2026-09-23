// src/games/shared/snapshot.js
//
// Helpers so GameEngine classes can opt into match resume with minimal code.

/** Deep-clone plain JSON-safe game state. */
export function cloneState(value) {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

/**
 * Standard snapshot shape for engines that keep authoritative data on
 * `this.state` (party games) plus a few common private fields.
 */
export function snapshotFromState(engine, extra = {}) {
  return {
    kind: 'state',
    state: engine.state ? cloneState(engine.state) : null,
    mySeat: engine.mySeat,
    ...extra,
  }
}

export function applyStateSnapshot(engine, snap) {
  if (!snap || snap.kind !== 'state' || !snap.state) return false
  engine.state = cloneState(snap.state)
  if (snap.mySeat != null) engine.mySeat = snap.mySeat
  return true
}
