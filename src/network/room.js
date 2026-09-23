// src/network/room.js
//
// Reusable, serverless WebRTC mesh networking layer for every multiplayer
// game in the arcade. There is NO backend and NO signaling server we run
// ourselves — peer discovery/signaling happens over the public BitTorrent
// tracker network via Trystero's torrent strategy. Once peers discover each
// other they connect directly, peer-to-peer, over WebRTC data channels.
//
// Everything here lives strictly in RAM for the lifetime of the tab. There
// is no localStorage, no cookies, and no persistence of any kind — closing
// or refreshing the tab fully destroys the room state.
//
// NOTE ON IMPORT PATH: Trystero 0.25.x deprecated the bundled
// `trystero/torrent` re-export in favor of the standalone
// `@trystero-p2p/torrent` package (same maintainer, same API surface, just
// installed directly so it can be tree-shaken independently). We import
// from there so `joinRoom` actually resolves instead of throwing the
// "install and import from @trystero-p2p/torrent instead" deprecation
// error that `trystero/torrent` now raises at import time.
import { joinRoom, selfId } from '@trystero-p2p/torrent'

// Namespaces every room by game so two different games never collide on
// the same BitTorrent tracker "swarm", even if a player reuses a room code.
const APP_NAMESPACE = 'browser-arcade'

const noop = () => {}

/**
 * Creates a serverless WebRTC mesh room scoped to a single game + room code.
 *
 * @param {string} gameId - Catalog id of the game, e.g. "tank4". Used to
 *   namespace the signaling swarm so rooms never collide across games.
 * @param {string} roomId - Shareable room code the host generates and
 *   players join with, e.g. "K7QX2M".
 * @param {boolean} isHost - Whether the local peer is the authoritative
 *   host for this room. Only the host enforces the max player cap.
 * @param {number} maxPlayers - Total number of participants allowed in the
 *   room, INCLUDING the host. A `maxPlayers` of 4 means the host + 3 peers.
 * @param {object} [callbacks] - Event hooks wired up by the caller.
 * @param {(peerId: string) => void} [callbacks.onPeerJoin]
 * @param {(peerId: string) => void} [callbacks.onPeerLeave]
 * @param {(data: any, peerId: string) => void} [callbacks.onGameAction] -
 *   Fired when any peer sends data over the `game_action` channel (player
 *   inputs from clients, event messages, etc).
 * @param {(data: any, peerId: string) => void} [callbacks.onHostSync] -
 *   Fired when data arrives over the `host_sync` channel (authoritative
 *   state snapshots broadcast by the host at tick rate).
 * @param {() => void} [callbacks.onRoomFull] - Fired locally when this peer
 *   was rejected because the room it tried to join was already full.
 * @param {(peerId: string) => void} [callbacks.onPeerRejected] - Fired on
 *   the host when an incoming peer was auto-rejected for exceeding capacity.
 *
 * @returns {{
 *   broadcast: (data: any) => Promise<void>,
 *   sendTo: (peerId: string, data: any) => Promise<void>,
 *   broadcastSync: (data: any) => Promise<void>,
 *   sendSyncTo: (peerId: string, data: any) => Promise<void>,
 *   getPeers: () => string[],
 *   getSelfId: () => string,
 *   getPing: () => number|null,
 *   leave: () => Promise<void>,
 * }}
 */
export function createRoom(gameId, roomId, isHost, maxPlayers, callbacks = {}) {
  if (!gameId) throw new Error('createRoom: "gameId" is required')
  if (!roomId) throw new Error('createRoom: "roomId" is required')

  const {
    onPeerJoin = noop,
    onPeerLeave = noop,
    onGameAction = noop,
    onHostSync = noop,
    onRoomFull = noop,
    onPeerRejected = noop,
  } = callbacks

  const cappedMaxPlayers = Number.isFinite(maxPlayers) && maxPlayers > 0 ? maxPlayers : 1
  // Every player slot minus the host's own slot = capacity for OTHER peers.
  const peerCapacity = Math.max(cappedMaxPlayers - 1, 0)

  const config = { appId: `${APP_NAMESPACE}::${gameId}` }
  const room = joinRoom(config, roomId)

  // Two dedicated action channels, as required by the architecture:
  //  - `game_action`: player inputs / discrete events (client -> host, or
  //    host -> clients for one-off events).
  //  - `host_sync`: authoritative state snapshots broadcast by the host,
  //    plus internal room-management signals (e.g. room-full rejection).
  const gameAction = room.makeAction('game_action')
  const hostSyncAction = room.makeAction('host_sync')
  // Dedicated round-trip channel for the HUD latency readout. Kept separate
  // from game traffic so probes never reach a game engine's message handler.
  const rttAction = room.makeAction('rtt')

  const connectedPeers = new Set()
  /** peerId -> smoothed round-trip time in ms. */
  const peerRtt = new Map()
  let hasLeft = false

  rttAction.onMessage = (data, context) => {
    if (!data || typeof data !== 'object') return
    if (data.k === 'q') {
      // Echo the probe back with the original timestamp untouched.
      rttAction.send({ k: 'a', t: data.t }, { target: context.peerId }).catch(noop)
      return
    }
    if (data.k === 'a' && typeof data.t === 'number') {
      const rtt = Math.max(0, performance.now() - data.t)
      const prev = peerRtt.get(context.peerId)
      // Exponential smoothing keeps the HUD number readable instead of jumpy.
      peerRtt.set(context.peerId, prev == null ? rtt : prev * 0.65 + rtt * 0.35)
    }
  }

  const rttTimer = setInterval(() => {
    if (hasLeft || connectedPeers.size === 0) return
    rttAction.send({ k: 'q', t: performance.now() }).catch(noop)
  }, 2000)

  gameAction.onMessage = (data, context) => {
    onGameAction(data, context.peerId)
  }

  hostSyncAction.onMessage = (data, context) => {
    if (data && typeof data === 'object' && data.__system === 'ROOM_FULL') {
      onRoomFull()
      leave()
      return
    }
    onHostSync(data, context.peerId)
  }

  const rejectPeer = (peerId) => {
    onPeerRejected(peerId)
    // Tell the rejected peer why, best-effort (they may already be gone).
    hostSyncAction
      .send({ __system: 'ROOM_FULL', maxPlayers: cappedMaxPlayers }, { target: peerId })
      .catch(noop)
    // Give the message a moment to flush across the data channel before we
    // sever the connection from our end. In a serverless mesh there is no
    // central authority that can stop a peer from ever connecting to the
    // *other* peers in the room, so this is a best-effort disconnect of the
    // link between the host and the over-capacity peer; the peer is also
    // expected to call `leave()` itself upon receiving the ROOM_FULL signal.
    setTimeout(() => {
      const peers = room.getPeers()
      const connection = peers[peerId]
      if (connection) {
        try {
          connection.close()
        } catch {
          // no-op: connection may already be closed
        }
      }
    }, 250)
  }

  room.onPeerJoin = (peerId) => {
    if (isHost && connectedPeers.size >= peerCapacity) {
      rejectPeer(peerId)
      return
    }
    connectedPeers.add(peerId)
    onPeerJoin(peerId)
  }

  room.onPeerLeave = (peerId) => {
    connectedPeers.delete(peerId)
    peerRtt.delete(peerId)
    onPeerLeave(peerId)
  }

  /** Broadcast a game action to every connected peer. */
  function broadcast(data) {
    return gameAction.send(data)
  }

  /** Send a game action to a single peer. */
  function sendTo(peerId, data) {
    return gameAction.send(data, { target: peerId })
  }

  /** Host-authoritative state broadcast (30Hz tick, or per-turn snapshots). */
  function broadcastSync(data) {
    return hostSyncAction.send(data)
  }

  /** Host-authoritative state sent to a single peer (e.g. late joiner). */
  function sendSyncTo(peerId, data) {
    return hostSyncAction.send(data, { target: peerId })
  }

  /** Currently connected remote peer ids (does not include the local peer). */
  function getPeers() {
    return Object.keys(room.getPeers())
  }

  /** This local peer's id, stable for the lifetime of the tab. */
  function getSelfId() {
    return selfId
  }

  /**
   * Mean round-trip time across connected peers in ms, or null when there is
   * nobody to measure yet. Drives the HUD ping indicator.
   */
  function getPing() {
    if (peerRtt.size === 0) return null
    let total = 0
    for (const rtt of peerRtt.values()) total += rtt
    return total / peerRtt.size
  }

  /** Fully disconnect from the mesh and release all resources. Idempotent. */
  function leave() {
    if (hasLeft) return Promise.resolve()
    hasLeft = true
    clearInterval(rttTimer)
    connectedPeers.clear()
    peerRtt.clear()
    window.removeEventListener('pagehide', leave)
    return room.leave()
  }

  // Ephemeral-by-design safety net: if the tab is closed or navigated away
  // from without the app explicitly tearing the room down, disconnect
  // immediately so we never leave a dangling peer in someone else's mesh.
  window.addEventListener('pagehide', leave)

  return { broadcast, sendTo, broadcastSync, sendSyncTo, getPeers, getSelfId, getPing, leave }
}
