/**
 * Close Detection Tests
 *
 * Verifies the close logic: closeSignal && turnCount >= 8 → canContinue false.
 * Tests edge cases: fewer turns, no signal, exact boundary.
 */

module.exports = function (test, assert, helpers) {
  // Simulate the close detection logic from server.js handleMessage
  function shouldClose(collabState) {
    if (!collabState) return false;
    return Boolean(collabState.closeSignal && collabState.turnCount >= 8);
  }

  test('closeSignal true + turnCount >= 8 returns true', () => {
    assert.ok(shouldClose({ closeSignal: true, turnCount: 8 }));
    assert.ok(shouldClose({ closeSignal: true, turnCount: 10 }));
    assert.ok(shouldClose({ closeSignal: true, turnCount: 30 }));
  });

  test('closeSignal true + turnCount < 8 returns false', () => {
    assert.equal(shouldClose({ closeSignal: true, turnCount: 7 }), false);
    assert.equal(shouldClose({ closeSignal: true, turnCount: 1 }), false);
    assert.equal(shouldClose({ closeSignal: true, turnCount: 0 }), false);
  });

  test('closeSignal false + high turnCount returns false', () => {
    assert.equal(shouldClose({ closeSignal: false, turnCount: 20 }), false);
    assert.equal(shouldClose({ closeSignal: false, turnCount: 100 }), false);
  });

  test('no collab state returns false', () => {
    assert.equal(shouldClose(null), false);
    assert.equal(shouldClose(undefined), false);
  });

  test('exact boundary: turnCount === 8 with close signal', () => {
    assert.ok(shouldClose({ closeSignal: true, turnCount: 8 }));
  });

  test('exact boundary: turnCount === 7 with close signal', () => {
    assert.equal(shouldClose({ closeSignal: true, turnCount: 7 }), false);
  });

  // Integration-style: test via actual handleMessage callback shape
  test('handleMessage return shape matches canContinue logic', () => {
    // Simulate what server.js handleMessage does
    function simulateHandleMessage(collabState) {
      let canContinue = true;
      if (collabState && collabState.closeSignal && collabState.turnCount >= 8) {
        canContinue = false;
      }
      return { text: 'response', canContinue };
    }

    const open = simulateHandleMessage({ closeSignal: false, turnCount: 10 });
    assert.equal(open.canContinue, true);

    const closing = simulateHandleMessage({ closeSignal: true, turnCount: 8 });
    assert.equal(closing.canContinue, false);

    const tooEarly = simulateHandleMessage({ closeSignal: true, turnCount: 5 });
    assert.equal(tooEarly.canContinue, true);

    const noState = simulateHandleMessage(null);
    assert.equal(noState.canContinue, true);
  });
};
