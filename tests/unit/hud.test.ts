// The leaderboard shows a mass on every row.
import { describe, expect, it } from 'vitest';
import { boardRows, UNNAMED } from '../../src/ui/hud.ts';
import { Organism } from '../../src/sim/organism.ts';

const ctl = { update() {} };
function org(id: number, name: string, mass: number): Organism {
  const o = new Organism(id, name, 0, ctl, false);
  o.alive = true;
  o.lastMass = mass;
  return o;
}

describe('boardRows', () => {
  const board = Array.from({ length: 30 }, (_, i) => org(i, `n${i}`, 3000.7 - i * 50));

  it('lists the top 10 in order with floored masses', () => {
    const rows = boardRows(board, null);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[0]).toEqual({ rank: 1, name: 'n0', mass: 3000, me: false });
    expect(rows[9].mass).toBe(2550);
  });

  it('appends the player with their true rank when outside the top 10', () => {
    const rows = boardRows(board, board[24]);
    expect(rows).toHaveLength(11);
    expect(rows[10]).toEqual({ rank: 25, name: 'n24', mass: 1800, me: true });
  });

  it('does not duplicate the player inside the top 10', () => {
    const rows = boardRows(board, board[3]);
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.me).map((r) => r.rank)).toEqual([4]);
  });

  it('skips a dead player and names unnamed cells', () => {
    const p = org(99, '', 10);
    p.alive = false;
    expect(boardRows([...board, p], p)).toHaveLength(10);
    expect(boardRows([org(1, '', 5)], null)[0].name).toBe(UNNAMED);
  });
});
