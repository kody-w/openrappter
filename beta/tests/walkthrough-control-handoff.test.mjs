import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateControlHandoff,
} from "../scripts/walkthrough-via-chat.mjs";

test("walkthrough includes a measured direct-to-Surgeon control handoff", () => {
  const baseline = {
    directTurns: [
      {
        request_id: 1,
        response: "DIRECT_BRAINSTEM_READY_1",
      },
      {
        request_id: 2,
        response: "DIRECT_BRAINSTEM_READY_2",
      },
    ],
    transcript: [
      "DIRECT_BRAINSTEM_READY_1",
      "DIRECT_BRAINSTEM_READY_2",
      "LEARNED_AND_TAUGHT:RAPP_READY",
    ].join(" "),
    routeTelemetryBefore: {
      sequence: 4,
      navigation_count: 1,
      worker_count: 1,
      chat_lease_count: 0,
    },
    routeTelemetryAfter: {
      navigation_count: 1,
      worker_count: 1,
      chat_lease_count: 0,
      events: [
        {
          sequence: 5,
          type: "ephemeral-callback-end",
          request_id: 3,
        },
      ],
    },
  };
  assert.deepEqual(
    Object.values(evaluateControlHandoff(baseline)),
    Array(7).fill(true),
  );

  const mutations = [
    {
      failed: "direct_turns_complete",
      input: {
        ...baseline,
        directTurns: baseline.directTurns.slice(0, 1),
      },
    },
    {
      failed: "direct_request_ids_ordered",
      input: {
        ...baseline,
        directTurns: baseline.directTurns.map((turn) => ({
          ...turn,
          request_id: 1,
        })),
      },
    },
    {
      failed: "transcript_handoff_ordered",
      input: {
        ...baseline,
        transcript: [
          "DIRECT_BRAINSTEM_READY_2",
          "DIRECT_BRAINSTEM_READY_1",
          "LEARNED_AND_TAUGHT:RAPP_READY",
        ].join(" "),
      },
    },
    {
      failed: "surgeon_request_followed_direct_turns",
      input: {
        ...baseline,
        routeTelemetryAfter: {
          ...baseline.routeTelemetryAfter,
          events: [{
            sequence: 5,
            type: "ephemeral-callback-end",
            request_id: 2,
          }],
        },
      },
    },
    {
      failed: "no_iframe_replacement",
      input: {
        ...baseline,
        routeTelemetryAfter: {
          ...baseline.routeTelemetryAfter,
          navigation_count: 2,
        },
      },
    },
    {
      failed: "worker_count_stable",
      input: {
        ...baseline,
        routeTelemetryAfter: {
          ...baseline.routeTelemetryAfter,
          worker_count: 2,
        },
      },
    },
    {
      failed: "chat_lease_released",
      input: {
        ...baseline,
        routeTelemetryAfter: {
          ...baseline.routeTelemetryAfter,
          chat_lease_count: 1,
        },
      },
    },
  ];
  mutations.forEach((mutation, index) => {
    const result = evaluateControlHandoff(mutation.input);
    assert.equal(
      result[mutation.failed],
      false,
      `mutation ${index + 1} should fail ${mutation.failed}`,
    );
  });
});
