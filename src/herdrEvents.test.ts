import assert from "node:assert/strict";
import test from "node:test";
import { eventSubscriptionRequest } from "./herdrEvents";

test("event subscription request includes stable pane status subscriptions", () => {
  const request = JSON.parse(eventSubscriptionRequest("request-1", ["w1:p2", "w1:p1", "w1:p1"]));
  assert.equal(request.id, "request-1");
  assert.equal(request.method, "events.subscribe");
  assert.deepEqual(
    request.params.subscriptions.filter((subscription: { pane_id?: string }) => subscription.pane_id),
    [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ],
  );
  assert.ok(request.params.subscriptions.some((subscription: { type?: string }) => subscription.type === "layout.updated"));
});
