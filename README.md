# Sokoban Solver

[![Bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/anatadare/makefun-sokoban/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/anatadare/makefun-sokoban/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A Sokoban solver that wins on pushes, not on moves. Every level here is a
one-wide hallway with one to four rooms off it, and a box pushed out of a
room can never come back, so the level's push-optimal count is the sum of
its rooms' optima. This entry splits each level into rooms, solves every
room independently with a push-optimal A* search (minimum-assignment
heuristic plus frozen-box, wall-run and 2x2 deadlock pruning), and stitches
the room solutions together with walks through the hallway, which push
nothing. On the practice set it solves all five instances in exactly the
optimal push counts (13, 16, 29, 47, 60) for a perfect 1,000,000, against
the house baseline's 200,000, in about half a second for the whole set.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The program reads every instance under the input directory (`<id>/level.txt`
in XSB) and writes the player's moves to `<id>/solution.txt` under the output
directory. It needs nothing installed, reads no clock, and two runs write the
same bytes.

---

Optional: earn referral rewards, a second way to make money: [join make.fun with my referral link](https://make.fun/r/x5qvvfcq).
