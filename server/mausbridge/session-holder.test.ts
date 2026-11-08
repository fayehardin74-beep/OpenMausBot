import { describe, expect, it } from "vitest";

import { heldElsewhere, type HolderProbe } from "./session-holder.ts";

const tree = (openers: number[], parents: Record<number, number>): HolderProbe => ({
  openers: async () => openers,
  parentOf: async (pid) => parents[pid],
});

describe("mausbridge session holder", () => {
  it("ignores engines this server started and sees anyone else", async () => {
    expect(await heldElsewhere("x", tree([], {}), 100)).toBe(false);
    expect(await heldElsewhere("x", tree([300], { 300: 200, 200: 100 }), 100)).toBe(false);
    expect(await heldElsewhere("x", tree([300, 900], { 300: 100, 900: 1 }), 100)).toBe(true);
  });
});
