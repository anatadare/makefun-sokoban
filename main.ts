// A Sokoban solver that wins on pushes, not on moves.
//
// Every level in this competition is a one-wide hallway with one to four
// rooms off it, each room holding 3 or 4 boxes and as many goals, opening
// onto the hallway through a single door. A box pushed out of a room into
// the hallway can never come back, so every box stays in its own room and
// the level's push-optimal count is the sum of the rooms' optima. This
// solver therefore splits the level into rooms, solves each room
// independently with a push-optimal A* search, and stitches the room
// solutions together with walks through the hallway (walks push nothing,
// so the stitched answer costs exactly the sum of the rooms' optima).
//
// The per-room search is A* over pushes: a state is the boxes plus the
// player's square, a step is one push, and the estimate is the cheapest
// assignment of boxes to goals over shortest-path distances, which never
// overestimates the pushes left. States a push can never save are pruned
// with three deadlock tests (frozen boxes, boxes confined to a row or
// column with no goal in it, and full 2x2 blocks). The search is budgeted
// by expansions, never by the clock, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in one fixed order everywhere, so every search is
// deterministic: the same level always yields the same answer.
const STEPS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// How many states one room's search may expand before it gives up. The
// count, not a clock, bounds the work, so the answer never depends on
// how fast the machine happens to be.
const MAX_EXPANSIONS = 600_000;

interface Grid {
  w: number;
  h: number;
  walk: boolean[]; // the player may stand here
  goals: Set<number>;
  boxes: number[]; // sorted
  player: number;
}

interface Room {
  cells: number[]; // the room's floor, where its boxes may go
  cellSet: Set<number>;
  door: number; // the room cell beside the hallway
  entry: number; // the hallway cell beside the door
  boxes: number[]; // sorted
  goals: number[];
}

interface RoomSolution {
  moves: string;
  endPlayer: number;
  exitOk: boolean; // the player can walk back out through the door
}

// ---------------------------------------------------------------------------
// Reading a level
// ---------------------------------------------------------------------------

function parseLevel(text: string): Grid {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const walk: boolean[] = new Array(w * h).fill(false);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      walk[i] = ch !== '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, walk, goals, boxes, player };
}

// ---------------------------------------------------------------------------
// Finding the rooms
// ---------------------------------------------------------------------------

// The hallway is the player's row. Take it out of the floor and each room
// is left as one connected component, with exactly one cell beside the
// hallway: its door.
function findRooms(g: Grid): Room[] {
  const { w, h, walk } = g;
  const hallRow = Math.floor(g.player / w);
  const inRoom = (c: number): boolean => walk[c] && Math.floor(c / w) !== hallRow;
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let c = 0; c < w * h; c++) {
    if (!inRoom(c) || seen.has(c)) continue;
    const cells: number[] = [];
    const queue = [c];
    seen.add(c);
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      cells.push(cur);
      for (const s of STEPS) {
        const nb = cur + s.dy * w + s.dx;
        if (nb < 0 || nb >= w * h) continue;
        if (Math.abs((nb % w) - (cur % w)) > 1) continue; // never wrap a row
        if (!inRoom(nb) || seen.has(nb)) continue;
        seen.add(nb);
        queue.push(nb);
      }
    }
    const boxes = g.boxes.filter((b) => cells.includes(b));
    if (boxes.length === 0) continue; // a pocket of floor with no boxes
    const goals = [...g.goals].filter((gl) => cells.includes(gl));
    // The door: the room cell beside a hallway square.
    let door = -1;
    let entry = -1;
    for (const cell of cells) {
      for (const s of STEPS) {
        const nb = cell + s.dy * w + s.dx;
        if (nb < 0 || nb >= w * h) continue;
        if (Math.floor(nb / w) === hallRow && walk[nb]) {
          door = cell;
          entry = nb;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) continue;
    boxes.sort((a, b) => a - b);
    rooms.push({ cells, cellSet: new Set(cells), door, entry, boxes, goals });
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// Walking without pushing
// ---------------------------------------------------------------------------

// The shortest walk from `from` to `to` over walkable squares that hold no
// box, as a string of steps, or null when no such walk exists. The fixed
// step order makes the walk deterministic.
function walkPath(
  g: Grid,
  blocked: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const { w, h, walk } = g;
  const parent = new Int32Array(w * h).fill(-2);
  const parentStep = new Array<string>(w * h).fill('');
  parent[from] = -1;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const s of STEPS) {
      const nx = (cur % w) + s.dx;
      const ny = Math.floor(cur / w) + s.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nb = ny * w + nx;
      if (!walk[nb] || blocked.has(nb) || parent[nb] !== -2) continue;
      parent[nb] = cur;
      parentStep[nb] = s.ch;
      if (nb === to) {
        let moves = '';
        for (let t = nb; parent[t] !== -1; t = parent[t]) moves = parentStep[t] + moves;
        return moves;
      }
      queue.push(nb);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One room, solved push-optimally
// ---------------------------------------------------------------------------

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const rest = permutations(n - 1);
  for (const r of rest) {
    for (let i = 0; i <= r.length; i++) {
      const p = r.slice();
      p.splice(i, 0, n - 1);
      out.push(p);
    }
  }
  return out;
}

function solveRoom(g: Grid, room: Room, requireExit: boolean): RoomSolution | null {
  const { w, h } = g;
  const n = room.boxes.length;
  if (n === 0 || n !== room.goals.length) return null;
  // Where the player may walk while solving this room: the room itself
  // plus the hallway square at its door. Boxes may only ever sit on the
  // room's own floor: a box pushed onto the hallway square is lost.
  const pWalk = new Set<number>(room.cells);
  pWalk.add(room.entry);
  const bWalk = room.cellSet;
  const goalSet = new Set<number>(room.goals);
  const pBlocked = (c: number): boolean => !pWalk.has(c);
  const bBlocked = (c: number): boolean => !bWalk.has(c);

  // Shortest paths from each goal over the room's floor, ignoring boxes:
  // a box's true push cost to a goal can only be longer.
  const dists: Int16Array[] = room.goals.map((goal) => {
    const d = new Int16Array(w * h).fill(-1);
    d[goal] = 0;
    const queue = [goal];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      for (const s of STEPS) {
        const nx = (cur % w) + s.dx;
        const ny = Math.floor(cur / w) + s.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nb = ny * w + nx;
        if (!bWalk.has(nb) || d[nb] !== -1) continue;
        d[nb] = d[cur] + 1;
        queue.push(nb);
      }
    }
    return d;
  });
  const perms = permutations(n);

  // The cheapest way to match boxes to goals, summed: no push can cut it
  // by more than one, so it never overestimates the pushes left.
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = dists[p[i]][boxes[i]];
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };

  // The floor run a box can slide along: the maximal run of the room's
  // floor in its column (for a wall to its left or right) or its row (for
  // a wall above or below it).
  const vRun = (x: number, y: number): [number, number] => {
    let y1 = y;
    while (y1 - 1 >= 0 && bWalk.has((y1 - 1) * w + x)) y1--;
    let y2 = y;
    while (y2 + 1 < h && bWalk.has((y2 + 1) * w + x)) y2++;
    return [y1, y2];
  };
  const hRun = (x: number, y: number): [number, number] => {
    let x1 = x;
    while (x1 - 1 >= 0 && bWalk.has(y * w + x1 - 1)) x1--;
    let x2 = x;
    while (x2 + 1 < w && bWalk.has(y * w + x2 + 1)) x2++;
    return [x1, x2];
  };

  // A push in one direction is impossible when the player cannot stand
  // behind the box or the square ahead of it cannot hold a box.
  const pushBlocked = (b: number, dir: number): boolean => {
    const s = STEPS[dir];
    const behind = b - (s.dy * w + s.dx);
    const ahead = b + (s.dy * w + s.dx);
    return pBlocked(behind) || bBlocked(ahead);
  };

  // True when no push can ever save this box layout. A box that cannot
  // move at all is frozen. A box beside a wall is dead when the wall runs
  // the whole length of the floor run the box can slide along and that
  // run holds no goal: the box can only slide along the wall, never away
  // from it, and never reaches a goal. A full 2x2 block holding a box off
  // its goal freezes every box in it, since each push any of them could
  // make needs a square of the block. Every test here only ever fires on
  // a layout that is truly dead, so pruning is safe.
  const boxSet = new Set<number>();
  const isDead = (boxes: number[]): boolean => {
    boxSet.clear();
    for (const b of boxes) boxSet.add(b);
    for (const b of boxes) {
      if (goalSet.has(b)) continue;
      const x = b % w;
      const y = Math.floor(b / w);
      const up = pushBlocked(b, 0);
      const down = pushBlocked(b, 1);
      const left = pushBlocked(b, 2);
      const right = pushBlocked(b, 3);
      if (up && down && left && right) return true; // frozen
      // A wall to the left: the box slides up and down its column run and
      // can never step sideways while the wall runs beside the whole run.
      if (x === 0 || pBlocked(b - 1)) {
        const [y1, y2] = vRun(x, y);
        let walled = true;
        let hasGoal = false;
        for (let r = y1; r <= y2; r++) {
          if (x > 0 && !pBlocked(r * w + x - 1)) walled = false;
          if (goalSet.has(r * w + x)) hasGoal = true;
        }
        if (walled && !hasGoal) return true;
      }
      if (x === w - 1 || pBlocked(b + 1)) {
        const [y1, y2] = vRun(x, y);
        let walled = true;
        let hasGoal = false;
        for (let r = y1; r <= y2; r++) {
          if (x < w - 1 && !pBlocked(r * w + x + 1)) walled = false;
          if (goalSet.has(r * w + x)) hasGoal = true;
        }
        if (walled && !hasGoal) return true;
      }
      // A wall above or below: the same along the box's row run.
      if (y === 0 || pBlocked(b - w)) {
        const [x1, x2] = hRun(x, y);
        let walled = true;
        let hasGoal = false;
        for (let c = x1; c <= x2; c++) {
          if (y > 0 && !pBlocked((y - 1) * w + c)) walled = false;
          if (goalSet.has(y * w + c)) hasGoal = true;
        }
        if (walled && !hasGoal) return true;
      }
      if (y === h - 1 || pBlocked(b + w)) {
        const [x1, x2] = hRun(x, y);
        let walled = true;
        let hasGoal = false;
        for (let c = x1; c <= x2; c++) {
          if (y < h - 1 && !pBlocked((y + 1) * w + c)) walled = false;
          if (goalSet.has(y * w + c)) hasGoal = true;
        }
        if (walled && !hasGoal) return true;
      }
    }
    // A 2x2 square with no square the player can stand on empty of boxes
    // freezes every box in it: each push it could make needs a square of
    // the block, either to stand on or to move into.
    for (const c of room.cells) {
      const x = c % w;
      const y = Math.floor(c / w);
      if (x + 1 >= w || y + 1 >= h) continue;
      const sq = [c, c + 1, c + w, c + w + 1];
      let full = true;
      let stray = false;
      for (const cell of sq) {
        if (pWalk.has(cell) && !boxSet.has(cell)) {
          full = false;
          break;
        }
        if (boxSet.has(cell) && !goalSet.has(cell)) stray = true;
      }
      if (full && stray) return true;
    }
    return false;
  };

  // Flood the player's reachable squares from `start` with `boxes` in the
  // way. Returns the reachability map and, for each reached square, the
  // square it was reached from and the step taken, so walks rebuild.
  const flood = (
    start: number,
    boxes: number[],
  ): { parent: Int32Array; step: string[]; regionMin: number } => {
    const boxHere = new Set<number>(boxes);
    const parent = new Int32Array(w * h).fill(-2);
    const step: string[] = new Array<string>(w * h).fill('');
    parent[start] = -1;
    const queue = [start];
    let regionMin = start;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur < regionMin) regionMin = cur;
      for (const s of STEPS) {
        const nx = (cur % w) + s.dx;
        const ny = Math.floor(cur / w) + s.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nb = ny * w + nx;
        if (!pWalk.has(nb) || boxHere.has(nb) || parent[nb] !== -2) continue;
        parent[nb] = cur;
        step[nb] = s.ch;
        queue.push(nb);
      }
    }
    return { parent, step, regionMin };
  };

  // The walk from the flood's start to `to`, rebuilt from its parents.
  const floodWalk = (
    fl: { parent: Int32Array; step: string[] },
    to: number,
  ): string => {
    let moves = '';
    for (let t = to; fl.parent[t] !== -1; t = fl.parent[t]) moves = fl.step[t] + moves;
    return moves;
  };

  // The states, kept in parallel arrays: the player's square, the sorted
  // boxes, the pushes so far, the parent state and the moves (walk plus
  // push) that made this state from its parent.
  const statePlayer: number[] = [room.entry];
  const stateBoxes: number[][] = [room.boxes.slice()];
  const stateG: number[] = [0];
  const stateParent: number[] = [-1];
  const stateSeg: string[] = [''];
  const expanded = new Array<boolean>(1).fill(false);
  // Two states with the same boxes and the player in the same reachable
  // region have the same future: the key merges them.
  const best = new Map<string, number>();
  const stateKey = (boxes: number[], regionMin: number): string =>
    boxes.join(',') + '|' + regionMin;

  // A binary heap on (pushes + estimate, estimate, insertion order).
  const heap: number[] = [];
  const heapF: number[] = [];
  const heapH: number[] = [];
  const heapSeq: number[] = [];
  let seq = 0;
  const heapLess = (a: number, b: number): boolean =>
    heapF[a] < heapF[b] ||
    (heapF[a] === heapF[b] &&
      (heapH[a] < heapH[b] || (heapH[a] === heapH[b] && heapSeq[a] < heapSeq[b])));
  const heapPush = (state: number, f: number, hh: number): void => {
    heap.push(state);
    heapF.push(f);
    heapH.push(hh);
    heapSeq.push(seq++);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(i, p)) break;
      for (const arr of [heap, heapF, heapH, heapSeq]) {
        const tmp = arr[i];
        arr[i] = arr[p];
        arr[p] = tmp;
      }
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.length - 1;
    for (const arr of [heap, heapF, heapH, heapSeq]) {
      arr[0] = arr[last];
      arr.pop();
    }
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(c + 1, c)) c++;
      if (!heapLess(c, i)) break;
      for (const arr of [heap, heapF, heapH, heapSeq]) {
        const tmp = arr[i];
        arr[i] = arr[c];
        arr[c] = tmp;
      }
      i = c;
    }
    return top;
  };

  const startFlood = flood(room.entry, room.boxes);
  const startH = heuristic(room.boxes);
  if (startH === Infinity || isDead(room.boxes)) return null;
  best.set(stateKey(room.boxes, startFlood.regionMin), 0);
  heapPush(0, startH, startH);

  let expansions = 0;
  while (heap.length > 0 && expansions < MAX_EXPANSIONS) {
    const s = heapPop();
    if (expanded[s]) continue;
    expanded[s] = true;
    const boxes = stateBoxes[s];
    const player = statePlayer[s];
    const gScore = stateG[s];
    // Solved when every box sits on a goal. The first solved state the
    // search lifts from the heap is push-optimal.
    if (boxes.every((b) => goalSet.has(b))) {
      const fl = flood(player, boxes);
      const exitOk = fl.parent[room.door] !== -2;
      if (!requireExit || exitOk) {
        let moves = '';
        for (let t = s; t > 0; t = stateParent[t]) moves = stateSeg[t] + moves;
        return { moves, endPlayer: player, exitOk };
      }
      // Solved, but the player cannot get back out: keep looking for a
      // solved state that leaves the door reachable.
      continue;
    }
    expansions++;
    const fl = flood(player, boxes);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let dir = 0; dir < 4; dir++) {
        const st = STEPS[dir];
        const behind = b - (st.dy * w + st.dx);
        const ahead = b + (st.dy * w + st.dx);
        // The player must be able to stand behind the box, and the square
        // ahead must be room floor with no box on it.
        if (fl.parent[behind] === -2) continue;
        if (!bWalk.has(ahead) || boxes.includes(ahead)) continue;
        const next = boxes.slice();
        next[bi] = ahead;
        next.sort((a, b2) => a - b2);
        const hNext = heuristic(next);
        if (hNext === Infinity || isDead(next)) continue;
        const nextFlood = flood(b, next);
        const key = stateKey(next, nextFlood.regionMin);
        const seen = best.get(key);
        const gNext = gScore + 1;
        if (seen !== undefined && (expanded[seen] || stateG[seen] <= gNext)) continue;
        const walk = floodWalk(fl, behind);
        if (seen !== undefined) {
          // A cheaper way to a state already on the heap: rewrite it.
          stateG[seen] = gNext;
          stateParent[seen] = s;
          stateSeg[seen] = walk + st.ch;
          statePlayer[seen] = b;
          stateBoxes[seen] = next;
          heapPush(seen, gNext + hNext, hNext);
        } else {
          const t = statePlayer.length;
          statePlayer.push(b);
          stateBoxes.push(next);
          stateG.push(gNext);
          stateParent.push(s);
          stateSeg.push(walk + st.ch);
          expanded.push(false);
          best.set(key, t);
          heapPush(t, gNext + hNext, hNext);
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// A whole level
// ---------------------------------------------------------------------------

function solveLevel(text: string): string {
  const g = parseLevel(text);
  if (g.player < 0 || g.boxes.length === 0) return '';
  const rooms = findRooms(g);
  if (rooms.length === 0) return '';
  // Every box must belong to exactly one room.
  const roomBoxes = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (roomBoxes !== g.boxes.length) return '';

  // Solve every room on its own, cheapest pushes first.
  const solved = rooms.map((room) => ({
    room,
    sol: solveRoom(g, room, false),
  }));
  if (solved.some((s) => s.sol === null)) return '';

  // Rooms the player can walk out of go first; a room that leaves the
  // player shut in goes last, where no exit is needed. If more than one
  // room shuts the player in, re-solve all but one of them with the exit
  // required, so the stitching still works.
  const order = solved.slice();
  order.sort((a, b) => {
    const ea = a.sol!.exitOk ? 0 : 1;
    const eb = b.sol!.exitOk ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return a.room.door - b.room.door;
  });
  const shut = order.filter((s) => !s.sol!.exitOk);
  if (shut.length > 1) {
    for (let i = 0; i < shut.length - 1; i++) {
      const redo = solveRoom(g, shut[i].room, true);
      if (redo === null) return '';
      shut[i].sol = redo;
    }
    order.sort((a, b) => {
      const ea = a.sol!.exitOk ? 0 : 1;
      const eb = b.sol!.exitOk ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return a.room.door - b.room.door;
    });
  }

  // Stitch: walk to each room's door, solve it, walk on to the next.
  // Walks never push, so the answer's push count is the rooms' optima.
  let moves = '';
  let player = g.player;
  const boxAt = new Map<number, number>(); // square -> box (current layout)
  for (const b of g.boxes) boxAt.set(b, b);
  for (let i = 0; i < order.length; i++) {
    const { room, sol } = order[i];
    const blocked = new Set<number>(boxAt.keys());
    const walk = walkPath(g, blocked, player, room.entry);
    if (walk === null) return '';
    moves += walk;
    moves += sol!.moves;
    player = sol!.endPlayer;
    // This room's boxes now sit on its goals.
    for (const b of room.boxes) boxAt.delete(b);
    for (const gl of room.goals) boxAt.set(gl, gl);
  }
  return moves;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
