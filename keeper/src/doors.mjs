// The calendar: when each door opens, when its snapshot is taken, which drand round decides it.
import { roundAt, roundTime } from "./drand.mjs";

export const DOOR_HOUR_UTC = Number(process.env.DOOR_HOUR_UTC ?? 18);
export const YEAR = Number(process.env.ADVENT_YEAR ?? 2026);
export const SNAPSHOT_LEAD = Number(process.env.SNAPSHOT_LEAD_SECONDS ?? 10 * 60); // the list is pinned this long before the door
export const COMMIT_MARGIN = 60; // and the memo must land this long before the round
export const LAST_DOOR = Number(process.env.LAST_DOOR ?? 25);

/** Unix seconds at which door d opens. Doors run 1..LAST_DOOR in December; 0 and negatives are warm-up doors before it. */
const OVERRIDES = process.env.DOOR_TIMES ? JSON.parse(process.env.DOOR_TIMES) : {}; // {"-1": unixSeconds} for rehearsals
export function doorTime(d) {
  if (OVERRIDES[d] !== undefined) return Number(OVERRIDES[d]);
  return Math.floor(Date.UTC(YEAR, 11, d, DOOR_HOUR_UTC) / 1000);
}
export const snapshotTime = (d) => doorTime(d) - SNAPSHOT_LEAD;
export const doorRound = (d) => roundAt(doorTime(d));
export const doorRoundTime = (d) => Number(roundTime(doorRound(d)));

/** The door whose snapshot is the next one due at time t, with FIRST_DOOR..LAST_DOOR (warm-up doors allowed). */
export function nextDoor(t, { first = Number(process.env.FIRST_DOOR ?? 1), last = LAST_DOOR } = {}) {
  for (let d = first; d <= last; d++) if (doorTime(d) > t) return d;
  return null;
}
export const isSnapshotDue = (d, t) => t >= snapshotTime(d) && t < doorTime(d) - COMMIT_MARGIN;
export const isSettleDue = (d, t) => t >= doorRoundTime(d) + 2;
