/**
 * Delivery tracking.
 *
 * sock.sendMessage() resolving only means WhatsApp's server accepted the message for
 * relay; it says nothing about the recipient getting it. Baileys reports what happens next
 * through `messages.update` (status: 0 error, 2 server/sender ack, 3 delivered, 4 read,
 * 5 played). This keeps the highest status seen per message id so a lead is only reported
 * as delivered when a receipt actually came back.
 */

const ERROR = 0;
const DELIVERED = 3;

export function createDeliveryTracker() {
  const best = new Map();       // id -> highest status seen
  const failed = new Set();     // ids WhatsApp rejected
  let waiters = [];

  const onUpdate = (updates) => {
    for (const u of updates || []) {
      const id = u?.key?.id;
      const status = u?.update?.status;
      if (!id || !u.key.fromMe || typeof status !== 'number') continue;
      if (status === ERROR) failed.add(id);
      else if (status > (best.get(id) ?? -1)) best.set(id, status);
    }
    waiters = waiters.filter((w) => !w());
  };

  const stateOf = (id) => {
    if (!id) return 'unknown';
    if (failed.has(id)) return 'failed';
    const s = best.get(id) ?? -1;
    if (s >= 4) return 'read';
    if (s >= DELIVERED) return 'delivered';
    return 'pending';
  };

  return {
    attach(sock) { sock.ev.on('messages.update', onUpdate); },
    stateOf,
    /** Wait until every id is delivered/failed, or the timeout passes. */
    waitFor(ids, timeoutMs) {
      const done = () => ids.every((id) => stateOf(id) !== 'pending');
      if (!ids.length || done()) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters = waiters.filter((w) => w !== check); resolve(); }, timeoutMs);
        const check = () => (done() ? (clearTimeout(timer), resolve(), true) : false);
        waiters.push(check);
      });
    }
  };
}
