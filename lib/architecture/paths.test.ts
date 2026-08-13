import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAPABILITIES,
  KNOWN_GAPS,
  PATHS,
  hasCapability,
  missingFrom,
  sourceOf,
} from './paths';

describe('execution paths — the registry itself is well-formed', () => {
  it('has exactly one canonical path', () => {
    assert.equal(PATHS.filter((p) => p.canonical).length, 1);
  });

  it('every path resolves to real source', () => {
    for (const p of PATHS) {
      assert.ok(sourceOf(p).length > 500, `${p.id} resolved to no source — a file was moved or renamed`);
    }
  });

  it('every capability marker is distinctive enough to mean something', () => {
    for (const c of CAPABILITIES) {
      assert.ok(c.markers.length > 0, `${c.id} has no markers`);
      for (const m of c.markers) {
        assert.ok(m.length >= 5, `${c.id} marker "${m}" is too short to be a reliable signal`);
      }
    }
  });

  it('the canonical path actually has every capability — it is the definition', () => {
    const canonical = PATHS.find((p) => p.canonical)!;
    const src = sourceOf(canonical);
    const absent = CAPABILITIES.filter((c) => !hasCapability(src, c)).map((c) => c.id);
    assert.deepEqual(
      absent,
      [],
      `the canonical path is missing capabilities it defines: ${absent.join(', ')}. ` +
        'Either the capability moved (update its markers) or the company just lost something.',
    );
  });
});

// THE POINT OF THIS FILE.
//
// The direct executor is the fallback when the durable workflow fails to start.
// Before this test existed it was missing the distiller, the immunizer, the
// editor, the elastic workforce and the approval gate — so a failed workflow
// start quietly ran a weaker company, and no one found out until an audit.
describe('execution paths — no path is silently weaker than the canonical one', () => {
  for (const path of PATHS.filter((p) => !p.canonical)) {
    it(`${path.id}: every gap is declared in KNOWN_GAPS`, () => {
      const declared = new Set((KNOWN_GAPS[path.id] ?? []).map((g) => g.capability));
      const undeclared = missingFrom(path).map((c) => c.id).filter((id) => !declared.has(id));
      assert.deepEqual(
        undeclared,
        [],
        `${path.title} silently lacks: ${undeclared.join(', ')}.\n` +
          'Either wire the capability into this path, or add it to KNOWN_GAPS with a reason. ' +
          'What is not allowed is leaving it undiscovered.',
      );
    });

    it(`${path.id}: KNOWN_GAPS carries no stale entries`, () => {
      // A gap that has been closed must be removed from the ledger, or the list
      // stops meaning anything and starts hiding real regressions behind it.
      const actual = new Set(missingFrom(path).map((c) => c.id));
      const stale = (KNOWN_GAPS[path.id] ?? []).map((g) => g.capability).filter((id) => !actual.has(id));
      assert.deepEqual(stale, [], `${path.id} declares gaps that are already closed: ${stale.join(', ')} — delete them.`);
    });

    it(`${path.id}: every declared gap states why`, () => {
      for (const g of KNOWN_GAPS[path.id] ?? []) {
        assert.ok(g.why && g.why.length > 20, `gap "${g.capability}" needs a real reason, not "${g.why}"`);
      }
    });
  }
});
