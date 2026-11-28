import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { loader } from '../helpers/load.mjs'

// Uses synthetic data and a fresh session; never touches a student's AI history.
// The deployed Caddy gateway requires a token. No token => explicit skip.
test('live stateful tutor authenticates, replays completed turns and deletes its session', {
  skip: !process.env.TUTOR_API_URL || !process.env.TUTOR_API_TOKEN,
}, async () => {
  const { askTutor, deleteTutorSession } = loader()('lib/tutor.ts')
  const conversation = randomUUID(), key = randomUUID()
  const canary = `PRIVATE_REFERENCE_${randomUUID()}`
  const context = {
    conversation_id: conversation,
    message: 'Explain the idea of iterating through a list. Ask me a guiding question rather than giving a solution.',
    lab_context: { title: 'Synthetic integration check', instructions: 'Practice list iteration and doubling numbers.',
      starter: 'def double_all(nums):\n    pass\n', tests: 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n',
      solution: `# ${canary}\ndef double_all(nums):\n    return [n * 2 for n in nums]\n` },
    current_code: null, executed_code: null, output_error: null, validation_feedback: null,
  }
  try {
    const first = await askTutor(context, key)
    assert.ok(first.answer.trim())
    assert.ok(!first.answer.includes(canary))
    assert.deepEqual(await askTutor(context, key), first)
    const followup = { ...context, message: 'What should happen after I process one item?' }
    delete followup.lab_context
    assert.ok((await askTutor(followup, randomUUID())).answer.trim())
  } finally {
    await deleteTutorSession(conversation)
  }
  // Repeated cleanup is also successful when the remote session is absent.
  await deleteTutorSession(conversation)
})
