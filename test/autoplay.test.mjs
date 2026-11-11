import assert from "node:assert/strict";
import { mock, test } from "node:test";
import "./vscodeStub.mjs";

const { Autoplay } = await import("../out-test/ux/autoplay.js");
const { EventEmitter } = (await import("./vscodeStub.mjs")).vscodeStub;

const slide = { layout: "stack", blocks: [], beats: [{ say: "one" }, { say: "two" }] };
const steps = [
  { title: "Code", file: "a.ts", explanation: "Look here.", actions: [] },
  { title: "Slide", explanation: "Intro.", actions: [], slide },
];

function harness({ heard = true } = {}) {
  const changes = new EventEmitter();
  const finishes = new EventEmitter();
  const cursor = { index: 0, beat: 0 };
  const positions = (i) => (steps[i].slide ? steps[i].slide.beats.length + 1 : 1);
  const controller = {
    activeTourId: "tour",
    onDidChange: changes.event,
    snapshot: () => ({ plan: { steps }, index: cursor.index, beat: cursor.beat, positions: positions(cursor.index), current: steps[cursor.index] }),
    next: async () => {
      calls.push(`next ${cursor.index}.${cursor.beat}`);
      if (cursor.beat < positions(cursor.index) - 1) cursor.beat++;
      else if (cursor.index < steps.length - 1) Object.assign(cursor, { index: cursor.index + 1, beat: 0 });
      changes.fire();
    },
  };
  const calls = [];
  const tts = {
    onDidFinish: finishes.event,
    speakCurrent: () => {
      calls.push(`speak ${cursor.index}.${cursor.beat}`);
      return heard;
    },
    cancel: () => calls.push("cancel"),
  };
  const log = { appendLine: () => {} };
  const player = new Autoplay(controller, tts, log);
  const keyNow = () => JSON.stringify([cursor.beat, "tour", steps[cursor.index].root ?? null, null, steps[cursor.index].file ?? null, null, null, null, steps[cursor.index].title, steps[cursor.index].explanation]);
  return { player, calls, cursor, changes, finish: () => finishes.fire(keyNow()), finishStale: () => finishes.fire("old") };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("narrates each position, moves on when narration ends, and stops at the end", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness();
    h.player.start();
    assert.deepEqual(h.calls, ["speak 0.0"]);
    h.finishStale();
    mock.timers.tick(5000);
    assert.deepEqual(h.calls, ["speak 0.0"], "a stale end doesn't advance");
    for (const expected of ["1.0", "1.1", "1.2"]) {
      h.finish();
      mock.timers.tick(700);
      await flush();
      assert.equal(h.calls.at(-1), `speak ${expected}`);
    }
    h.finish();
    mock.timers.tick(700);
    await flush();
    assert.equal(h.player.isActive, false);
    assert.equal(h.calls.at(-1), "cancel");
  } finally {
    mock.timers.reset();
  }
});

test("waits a reading time when narration can't be heard", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness({ heard: false });
    h.player.start();
    mock.timers.tick(1700);
    await flush();
    assert.deepEqual(h.calls, ["speak 0.0"]);
    mock.timers.tick(200);
    await flush();
    assert.deepEqual(h.calls, ["speak 0.0", "next 0.0", "speak 1.0"]);
  } finally {
    mock.timers.reset();
  }
});

test("moving by hand while playing narrates from the new position", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness();
    h.player.start();
    Object.assign(h.cursor, { index: 1, beat: 2 });
    h.changes.fire();
    mock.timers.tick(250);
    assert.deepEqual(h.calls, ["speak 0.0", "speak 1.2"]);
    h.player.stop();
    assert.equal(h.player.isActive, false);
  } finally {
    mock.timers.reset();
  }
});
