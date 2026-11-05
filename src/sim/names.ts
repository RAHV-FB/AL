import type { Rng } from './rng';

const ONSETS = ['b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'kr', 'br', 'tr', 'dr', 'vy', 'ly', 'qu'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ou', 'ei', 'y'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'th', 'k', 'm', 'x'];

function syllable(rng: Rng): string {
  return rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(CODAS);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Short pronounceable agent name, e.g. "Kora", "Thesul". */
export function agentName(rng: Rng): string {
  const n = rng.chance(0.6) ? 2 : rng.chance(0.7) ? 1 : 3;
  let s = '';
  for (let i = 0; i < n; i++) s += syllable(rng);
  if (s.length > 9) s = s.slice(0, 9);
  return cap(s);
}

const TRIBE_SUFFIX = ['folk', 'clan', 'kin', 'ari', 'oth', 'ites', 'een', 'ura', 'ani'];

/** Tribe name, e.g. "Varn-kin", "Thesari". */
export function tribeName(rng: Rng): string {
  const root = syllable(rng) + (rng.chance(0.5) ? syllable(rng) : '');
  const suf = rng.pick(TRIBE_SUFFIX);
  return cap(root) + (rng.chance(0.5) ? '-' + suf : suf);
}
