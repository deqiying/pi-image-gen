import test from "node:test";
import assert from "node:assert/strict";
import imageGenerationExtension from "./index.js";

test("registers exactly one native image_gen tool for both extension hosts", () => {
  const registrations: any[] = [];
  const events: string[] = [];
  const fake = {
    registerTool: (definition: unknown) => registrations.push(definition),
    on: (event: string) => events.push(event),
  } as never;
  imageGenerationExtension(fake);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "image_gen");
  assert.deepEqual(events.sort(), ["before_agent_start", "model_select", "session_start"]);
  assert.equal(typeof registrations[0].execute, "function");
  assert.equal(typeof registrations[0].renderResult, "function");
  assert.equal(registrations[0].executionMode, "sequential");
});
