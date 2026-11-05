import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
import { generateWorld } from '../src/sim/world';
import { Rng } from '../src/sim/rng';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { TERRAIN_INFO } from '../src/sim/constants';

const CH = ['#', '~', '.', ',', 'T', ':', '^', 'W'];
it('preview', () => {
  for (const [seed, opts] of [[1, {}], [2, { divide: 'river' }], [3, { divide: 'mountains' }], [4, { waterLevel: 0.6 }], [5, { island: false }]] as const) {
    const t0 = performance.now();
    const w = generateWorld({ ...DEFAULT_CONFIG, seed }, new Rng(seed, 1), opts as any);
    const dt = performance.now() - t0;
    const counts = new Array(8).fill(0);
    let pass = 0;
    for (let i = 0; i < w.terrain.length; i++) { counts[w.terrain[i]]++; if (TERRAIN_INFO[w.terrain[i] as 0].passable) pass++; }
    let out = `seed ${seed} ${JSON.stringify(opts)} ${dt.toFixed(1)}ms passable=${(pass / w.terrain.length).toFixed(3)} counts=${counts.map((c) => (c / w.terrain.length).toFixed(3)).join(' ')}\n`;
    for (let y = 0; y < w.height; y += 3) {
      let row = '';
      for (let x = 0; x < w.width; x += 2) row += CH[w.terrain[y * w.width + x]];
      out += row + '\n';
    }
    appendFileSync('/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/preview.txt', out);
  }
});
