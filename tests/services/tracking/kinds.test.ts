import { describe, expect, test } from "bun:test";
import {
  ALL_KINDS,
  allowedKinds,
  HISTORY_KINDS,
  needsPalantir,
  PALANTIR_KINDS,
} from "../../../src/services/tracking/kinds.ts";

describe("tracking kinds", () => {
  test("no kind appears twice, across both lists", () => {
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);
  });

  test("the two lists do not overlap", () => {
    const history = new Set<string>(HISTORY_KINDS);
    const overlap = PALANTIR_KINDS.filter((kind) => history.has(kind));
    expect(overlap).toEqual([]);
  });

  test("needs palantir only for the behavioural kinds", () => {
    for (const kind of HISTORY_KINDS) expect(needsPalantir(kind)).toBe(false);
    for (const kind of PALANTIR_KINDS) expect(needsPalantir(kind)).toBe(true);
  });

  test("history off allows nothing, whatever palantir says", () => {
    expect(allowedKinds({ history: false, palantir: false }).size).toBe(0);
    expect(allowedKinds({ history: false, palantir: true }).size).toBe(0);
  });

  test("history on without palantir allows exactly the state kinds", () => {
    const allowed = allowedKinds({ history: true, palantir: false });
    expect(allowed.size).toBe(HISTORY_KINDS.length);
    for (const kind of PALANTIR_KINDS) expect(allowed.has(kind)).toBe(false);
  });

  test("both on allows everything", () => {
    expect(allowedKinds({ history: true, palantir: true }).size).toBe(ALL_KINDS.length);
  });
});
